/**
 * mqtt-worker-service/src/monitoring/metrics.js
 * 
 * Quản lý thống kê metrics của hệ thống Worker và định dạng Prometheus Exporter.
 * Hỗ trợ đầy đủ Operational Metrics & Business Metrics.
 */

const metrics = {
    telemetry_processed: 0,
    telemetry_accepted: 0,
    telemetry_rejected: 0,
    
    validation_unknown_keys: 0,
    validation_invalid_type: 0,
    validation_out_of_range: 0,

    telemetry_write_success: 0,
    telemetry_write_failure: 0,
    telemetry_retry: 0,
    shadow_retry: 0,
    
    dropped_limit: 0,
    dropped_retry_limit: 0,

    // Business Metrics
    command_success: 0,
    command_failure: 0,
    presence_transition_online: 0,
    presence_transition_offline: 0,
    catalog_reloads: 0,

    // Histogram cho Telemetry Processing Latency (giây)
    latency_buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    latency_counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // corresponding to buckets
    latency_inf_count: 0,
    latency_sum: 0,
    latency_count: 0,
};

function recordSanitizerStats(stats) {
    metrics.validation_unknown_keys += stats.unknown_keys || 0;
    metrics.validation_invalid_type += stats.invalid_type || 0;
    metrics.validation_out_of_range += stats.out_of_range || 0;
}

function observeLatency(seconds) {
    metrics.latency_count++;
    metrics.latency_sum += seconds;

    let placed = false;
    for (let i = 0; i < metrics.latency_buckets.length; i++) {
        if (seconds <= metrics.latency_buckets[i]) {
            metrics.latency_counts[i]++;
            placed = true;
            break;
        }
    }
    if (!placed) {
        metrics.latency_inf_count++;
    }
}

function recordCommandSuccess() {
    metrics.command_success++;
}

function recordCommandFailure() {
    metrics.command_failure++;
}

function recordPresenceTransition(isOnline) {
    if (isOnline) {
        metrics.presence_transition_online++;
    } else {
        metrics.presence_transition_offline++;
    }
}

function recordCatalogReload() {
    metrics.catalog_reloads++;
}

function recordTelemetryRetry() {
    metrics.telemetry_retry++;
}

function recordShadowRetry() {
    metrics.shadow_retry++;
}

function getPrometheusMetrics(telemetryWriter, shadowWriter) {
    // Thu thập thêm metrics từ các batch writers
    const twMetrics = telemetryWriter ? telemetryWriter.getMetrics() : {};
    const swMetrics = shadowWriter ? shadowWriter.stats : {};

    metrics.telemetry_processed = twMetrics.processed || metrics.telemetry_processed;
    metrics.telemetry_accepted = twMetrics.accepted || metrics.telemetry_accepted;
    metrics.telemetry_rejected = twMetrics.rejected || metrics.telemetry_rejected;
    metrics.telemetry_write_success = twMetrics.write_success || metrics.telemetry_write_success;
    metrics.telemetry_write_failure = twMetrics.write_failure || metrics.telemetry_write_failure;
    metrics.telemetry_retry = twMetrics.retry_count || metrics.telemetry_retry;
    metrics.shadow_retry = swMetrics.shadow_batch_retry_total || metrics.shadow_retry;
    metrics.dropped_limit = twMetrics.dropped_due_to_limit || metrics.dropped_limit;
    metrics.dropped_retry_limit = twMetrics.dropped_due_to_retry_limit || metrics.dropped_retry_limit;

    const mem = process.memoryUsage();
    let lines = [];

    // Helper function to format metric line
    const formatMetric = (name, value, type = 'counter', help = '') => {
        let res = '';
        if (help) res += `# HELP ${name} ${help}\n`;
        res += `# TYPE ${name} ${type}\n`;
        res += `${name} ${value}\n`;
        return res;
    };

    // ==========================================
    // 1. OPERATIONAL METRICS (Giám sát vận hành)
    // ==========================================
    lines.push('# === OPERATIONAL METRICS ===');
    lines.push(formatMetric('smarthome_telemetry_processed_total', metrics.telemetry_processed, 'counter', 'Total telemetry messages processed'));
    lines.push(formatMetric('smarthome_telemetry_accepted_total', metrics.telemetry_accepted, 'counter', 'Total telemetry messages accepted'));
    lines.push(formatMetric('smarthome_telemetry_rejected_total', metrics.telemetry_rejected, 'counter', 'Total telemetry messages rejected'));

    // Validation Errors
    lines.push(`# HELP smarthome_telemetry_validation_errors_total Validation errors grouped by type`);
    lines.push(`# TYPE smarthome_telemetry_validation_errors_total counter`);
    lines.push(`smarthome_telemetry_validation_errors_total{type="unknown_keys"} ${metrics.validation_unknown_keys}`);
    lines.push(`smarthome_telemetry_validation_errors_total{type="invalid_type"} ${metrics.validation_invalid_type}`);
    lines.push(`smarthome_telemetry_validation_errors_total{type="out_of_range"} ${metrics.validation_out_of_range}`);

    // DB writes & Retries
    lines.push(formatMetric('smarthome_telemetry_write_success_total', metrics.telemetry_write_success, 'counter', 'Total telemetry logs successfully written to DB'));
    lines.push(formatMetric('smarthome_telemetry_write_failure_total', metrics.telemetry_write_failure, 'counter', 'Total telemetry logs write failures to DB'));
    lines.push(formatMetric('smarthome_telemetry_retry_total', metrics.telemetry_retry, 'counter', 'Total telemetry database write retries'));
    lines.push(formatMetric('smarthome_shadow_retry_total', metrics.shadow_retry, 'counter', 'Total shadow database write retries'));
    
    // Dropped
    lines.push(`# HELP smarthome_telemetry_dropped_total Telemetry logs dropped due to limits`);
    lines.push(`# TYPE smarthome_telemetry_dropped_total counter`);
    lines.push(`smarthome_telemetry_dropped_total{reason="limit"} ${metrics.dropped_limit}`);
    lines.push(`smarthome_telemetry_dropped_total{reason="retry_limit"} ${metrics.dropped_retry_limit}`);

    // Batch sizes current
    if (twMetrics.queue_length !== undefined) {
        lines.push(formatMetric('smarthome_telemetry_queue_current_length', twMetrics.queue_length, 'gauge', 'Current main telemetry batch queue size'));
        lines.push(formatMetric('smarthome_telemetry_retry_queue_current_length', twMetrics.retry_queue_length, 'gauge', 'Current telemetry retry queue size'));
        lines.push(formatMetric('smarthome_telemetry_backpressure_unsubscribed', twMetrics.is_unsubscribed ? 1 : 0, 'gauge', 'Is subscriber unsubscribed due to backpressure'));
    }

    // Processing Latency Histogram
    lines.push(`# HELP smarthome_telemetry_processing_duration_seconds Telemetry processing latency in seconds`);
    lines.push(`# TYPE smarthome_telemetry_processing_duration_seconds histogram`);
    
    let cumulativeCount = 0;
    for (let i = 0; i < metrics.latency_buckets.length; i++) {
        cumulativeCount += metrics.latency_counts[i];
        lines.push(`smarthome_telemetry_processing_duration_seconds_bucket{le="${metrics.latency_buckets[i]}"} ${cumulativeCount}`);
    }
    cumulativeCount += metrics.latency_inf_count;
    lines.push(`smarthome_telemetry_processing_duration_seconds_bucket{le="+Inf"} ${cumulativeCount}`);
    lines.push(`smarthome_telemetry_processing_duration_seconds_sum ${metrics.latency_sum}`);
    lines.push(`smarthome_telemetry_processing_duration_seconds_count ${metrics.latency_count}`);

    // Node process stats
    lines.push(formatMetric('node_memory_rss_bytes', mem.rss, 'gauge', 'Resident set size of the process'));
    lines.push(formatMetric('node_memory_heap_used_bytes', mem.heapUsed, 'gauge', 'Heap used by the process'));

    // ==========================================
    // 2. BUSINESS METRICS (Chỉ số nghiệp vụ)
    // ==========================================
    lines.push('\n# === BUSINESS METRICS ===');
    
    // Command Success Rate
    lines.push(formatMetric('smarthome_commands_success_total', metrics.command_success, 'counter', 'Total successfully sent commands to MQTT broker'));
    lines.push(formatMetric('smarthome_commands_failure_total', metrics.command_failure, 'counter', 'Total failed commands'));
    
    // Presence Transitions
    lines.push(`# HELP smarthome_presence_transitions_total Presence transitions count by state`);
    lines.push(`# TYPE smarthome_presence_transitions_total counter`);
    lines.push(`smarthome_presence_transitions_total{state="online"} ${metrics.presence_transition_online}`);
    lines.push(`smarthome_presence_transitions_total{state="offline"} ${metrics.presence_transition_offline}`);

    // Catalog reload
    lines.push(formatMetric('smarthome_catalog_reloads_total', metrics.catalog_reloads, 'counter', 'Total catalog cache reloads executed'));

    return lines.join('\n') + '\n';
}

module.exports = {
    recordSanitizerStats,
    observeLatency,
    recordCommandSuccess,
    recordCommandFailure,
    recordPresenceTransition,
    recordCatalogReload,
    recordTelemetryRetry,
    recordShadowRetry,
    getPrometheusMetrics,
};
