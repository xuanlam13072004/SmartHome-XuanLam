const fs = require('fs');
const path = require('path');

const reportsDir = path.join(__dirname, '../reports');

if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

function writeReport(scenarioName, data) {
  const reportPath = path.join(reportsDir, `report_scenario_${scenarioName.toLowerCase().replace(/ /g, '_')}.md`);
  
  const archChecksStr = data.architecturalValidations
    .map(val => `* [x] ${val}`)
    .join('\n');

  const issuesStr = data.issues && data.issues.length > 0
    ? data.issues.map(iss => `* ${iss}`).join('\n')
    : '* Không phát hiện lỗi';

  const content = `# Báo Cáo Nghiệm Thu Kiến Trúc Runtime: ${scenarioName}

* **Thời gian thực hiện**: ${new Date().toLocaleString('vi-VN')}
* **Tổng thời gian chạy (Total Execution Time)**: ${data.executionTime} ms
* **Kết quả chung (Status)**: ${data.status}

## 1. Chỉ số Hiệu năng Đo đạc (Performance Metrics)
* Độ trễ trung bình (Average Latency): ${data.metrics?.averageLatency !== undefined ? data.metrics.averageLatency.toFixed(2) + ' ms' : 'N/A'}
* Độ trễ phân vị 95 (P95 Latency): ${data.metrics?.p95Latency !== undefined ? data.metrics.p95Latency.toFixed(2) + ' ms' : 'N/A'}
* Độ trễ phân vị 99 (P99 Latency): ${data.metrics?.p99Latency !== undefined ? data.metrics.p99Latency.toFixed(2) + ' ms' : 'N/A'}
* Số bản tin xử lý thành công: ${data.metrics?.successCount || 0} | Bị loại bỏ: ${data.metrics?.droppedCount || 0}

## 2. Kiểm chứng Ràng buộc Kiến trúc (Architecture Validation)
${archChecksStr}

## 3. Lịch sử Tiện ích & Lỗi (Issues & Warnings)
${issuesStr}

## 4. Kết luận (Conclusion)
* ${data.conclusion}
`;

  fs.writeFileSync(reportPath, content, 'utf8');
  console.log(`[REPORT] Generated scenario report: ${reportPath}`);
}

module.exports = { writeReport };
