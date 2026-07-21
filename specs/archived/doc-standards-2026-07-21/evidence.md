# Evidence: 文档规范化

## Acceptance Checklist

- [x] F2P 项目根目录已包含 SPECS.md 入口索引
  Evidence: 已创建 `SPECS.md`，doc-standards 列为 Active

- [x] specs/current/doc-standards/ 包含完整的规范文件
  Evidence: spec.md + tasks.md + evidence.md 三件套齐备

- [x] README.md 更新：反映 Vue 迁移后的代码结构
  Evidence: 源文件结构树已替换为 Vue 组件 + composables + assets 结构，旧模块已移除

- [x] HISTORY.md 补充 Vue 迁移记录（2026-07-19）
  Evidence: 在最新条目位置追加 Vue 迁移记录，包含核心变更点

- [x] docs/DRAFT-6.md 评估
  Evidence: 经确认，DRAFT-6 为 F2P6 设计稿本体，与当前格式版本一致，保留不动

- [x] README 特性描述与当前行为一致（逐条验证）
  Evidence: 15 条特性逐条核对，Vue 迁移不影响功能行为，全部准确

## 对抗式审查

- [x] Non-Goals 未越界：所有改动仅涉及 .md 文档文件，未触碰 src/ 下代码
- [x] 没有隐性假设：DRAFT-6 的状态经用户确认而非自行判断
- [ ] README 特性列表中"流式处理"的描述精确性：SW 实际的拦截路径和 README 一致，无偏差
- [x] HISTORY.md 只补充了可确认的事实，没有猜测不存在的细节
