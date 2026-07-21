const DEFAULT_SAMPLE_LIMIT = 30;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function finite(value, fallback = 0) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; }

class AdaptiveScheduler {
  constructor(state = {}) {
    this.state = {
      version: 1,
      enabled: state.enabled !== false,
      samples: Array.isArray(state.samples) ? state.samples.slice(-DEFAULT_SAMPLE_LIMIT) : [],
      ewmaGenerationMs: finite(state.ewmaGenerationMs, 0),
      successCount: Math.max(0, finite(state.successCount, 0)),
      failureCount: Math.max(0, finite(state.failureCount, 0)),
      rateLimitCount: Math.max(0, finite(state.rateLimitCount, 0)),
      consecutiveSuccesses: Math.max(0, finite(state.consecutiveSuccesses, 0)),
      consecutiveFailures: Math.max(0, finite(state.consecutiveFailures, 0)),
      lastDelaySeconds: Math.max(0, finite(state.lastDelaySeconds, 0)),
      lastUpdatedAt: state.lastUpdatedAt || null,
    };
  }

  snapshot() { return { ...this.state, samples: [...this.state.samples] }; }

  record({ outcome, generationMs = 0, images = 0, qualityRejected = 0, rateLimited = false } = {}) {
    const success = outcome === 'success' && images >= 5;
    const duration = Math.max(0, finite(generationMs, 0));
    const sample = { at: new Date().toISOString(), outcome: rateLimited ? 'rate-limit' : (outcome || 'failure'), generationMs: duration, images: Math.max(0, finite(images, 0)), qualityRejected: Math.max(0, finite(qualityRejected, 0)) };
    this.state.samples.push(sample);
    this.state.samples = this.state.samples.slice(-DEFAULT_SAMPLE_LIMIT);
    if (duration > 0 && images > 0) this.state.ewmaGenerationMs = this.state.ewmaGenerationMs > 0 ? Math.round(this.state.ewmaGenerationMs * 0.72 + duration * 0.28) : Math.round(duration);
    if (success) {
      this.state.successCount += 1; this.state.consecutiveSuccesses += 1; this.state.consecutiveFailures = 0;
    } else {
      this.state.failureCount += 1; this.state.consecutiveFailures += 1; this.state.consecutiveSuccesses = 0;
    }
    if (rateLimited) this.state.rateLimitCount += 1;
    this.state.lastUpdatedAt = sample.at;
    return this.snapshot();
  }

  recentFailureRate(windowSize = 12) {
    const samples = this.state.samples.slice(-Math.max(1, windowSize));
    if (!samples.length) return 0;
    return samples.filter((item) => item.outcome !== 'success').length / samples.length;
  }

  generationTimeoutSeconds(configuredSeconds) {
    const configured = clamp(Math.trunc(finite(configuredSeconds, 180)), 30, 900);
    if (!this.state.enabled || !this.state.ewmaGenerationMs || this.state.samples.length < 3) return configured;
    const failurePenalty = 1 + this.recentFailureRate() * 0.45;
    const target = Math.ceil((this.state.ewmaGenerationMs / 1000) * 1.35 * failurePenalty + 25);
    return clamp(target, Math.min(60, configured), configured);
  }

  nextDelaySeconds(minSeconds, maxSeconds, random = Math.random) {
    const min = Math.max(0, Math.trunc(finite(minSeconds, 0)));
    const max = Math.max(min, Math.trunc(finite(maxSeconds, min)));
    if (max === min || !this.state.enabled) return min + Math.floor(random() * (max - min + 1));
    const failureRate = this.recentFailureRate();
    const failurePressure = clamp(failureRate * 0.75 + this.state.consecutiveFailures * 0.12, 0, 1);
    const successDiscount = clamp(this.state.consecutiveSuccesses * 0.08, 0, 0.35);
    const position = clamp(0.12 + failurePressure - successDiscount, 0, 1);
    const jitter = (random() - 0.5) * 0.18;
    const delay = Math.round(min + (max - min) * clamp(position + jitter, 0, 1));
    this.state.lastDelaySeconds = delay;
    return delay;
  }

  rateLimitCooldownMinutes(level) {
    const base = [10, 20, 40, 60][clamp(Math.trunc(finite(level, 1)), 1, 4) - 1];
    const recentRateLimits = this.state.samples.slice(-10).filter((item) => item.outcome === 'rate-limit').length;
    return clamp(base + Math.max(0, recentRateLimits - 1) * 5, 10, 90);
  }
}

module.exports = { AdaptiveScheduler };
