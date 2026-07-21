# Files2Picture 文档规范化

## Goal

将 Files2Picture 项目的文档体系纳入 SDD 规范，建立 specs/ 目录结构和 SPECS.md 入口索引，并同步更新现有文档使其与 Vue 迁移后的代码状态一致。

## Non-Goals

- 不改任何代码逻辑、功能或架构
- 不重构现有文档结构（docs/ 目录保留现有文件）
- 不修改二进制格式说明（README 中的格式规范准确，保留不变）
- 不做代码层面的质量改进（lint、测试等）

## Acceptance Criteria

- [ ] F2P 项目根目录已包含 SPECS.md 入口索引，列出当前活跃/已完成/已废弃的 spec
- [ ] `specs/current/doc-standards/` 包含完整的规范文件（spec、tasks、evidence）
- [ ] README.md 更新：反映 Vue 迁移后的代码结构（src/ 目录树以 Vue 组件和 composables 为主）
- [ ] HISTORY.md 补充 Vue 迁移记录（2026-07-19），日期和描述对齐真实改动过程
- [ ] docs/DRAFT-6.md 做评估：判断是否与当前代码一致，保留或标记过期
- [ ] README 中的特性描述和当前行为一致（逐条验证）

## Boundary Conditions

- Vue 迁移过程中如果有尚未完全迁移的模块（如 lib/ 目录可能仍存旧代码），标记而非强改
- 部分组件（如 f2p-core.js）是 Vue 和 SW 共享的，README 的描述需准确反映这种共享关系

## Constraints

- 所有变更只涉及文档文件（.md），不触碰 src/ 下的代码文件
- 文档风格保持现有的极简精确风格，不加入"仪式感"描述
