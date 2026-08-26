# hydrooj-similarity

Hydro OJ 用户代码查重插件：比赛/作业**结束后**对参赛者代码两两比对，基于 **Sørensen–Dice 相似度系数**（k-gram 指纹），提供相似对表格、并排 diff 证据视图与全屏**抄袭关系网**（零依赖 Canvas 力导向图）。仅管理员可用。

- 相似度分级：**完全相同 ≥ 0.95 / 高度 ≥ 0.75 / 疑似 ≥ 0.55 / 无**（阈值可在面板与系统设置中调节，从宽起报、人工复核）
- 防误判：去注释/去 `#include`/`import`/`uses` 等模板行、字符串/字符/数字/标识符归一化、空白不敏感、Pascal 大小写不敏感、过短代码（< 40 token）跳过、**只在同题提交间比对**、归一化后同哈希直接判"完全相同"
- 性能：按 rid 缓存 k-gram 指纹（`sim.fingerprint`，命中则完全跳过读码）、同源代码折叠分组后按组比对、事件循环定期让出、批量落库
- 非实时：赛后定时触发（`endAt + grace`）+ 每小时兜底扫描 + 面板手动触发，绝不占用评测算力；worker 侧 CAS 占位后 `setImmediate` 异步执行，不阻塞 judge 派发

## 安装

```bash
# 假设已按 Hydro 文档完成 hydrooj 安装
hydrooj addon add /path/to/hydro-simulation   # 或你的部署路径
hydrooj serve
```

依赖：hydrooj ≥ 5（mongodb 7.x 由其间接提供）。安装后重启即生效：

- 域管理后台侧边栏出现 **Sim Detection / 代码查重**（需要 `PERM_EDIT_DOMAIN`，即域管理员）
- 每个比赛/作业的报告也可直接经 `/d/<domainId>/contest/<tid>/sim` 按比赛进入

## 使用

1. 进入域 → 管理面板 → **代码查重**：列出全部比赛/作业（可按 比赛/作业 筛选），每行显示最近一次报告状态与统计
2. 比赛结束后点击 **立即查重**（可选 `latest`=每人每题最后一次提交 / `all`=全部提交，并可临时调整三级阈值；留空用全局默认）
3. 报告页：分级统计、按等级/题目筛选的相似对列表（相似度、双方用户、语言、递交链接）
4. **对比**：并排行级 diff（新增/删除高亮；超大文件自动降级为无高亮并排视图）
5. **抄袭关系网**：全屏 Canvas 力导向图 —— 节点=用户（颜色=涉及最高等级，大小=连接数），边=相似对（颜色=等级，粗细/透明度=相似度）；支持拖拽、平移、滚轮缩放、hover 高亮、点边直达 diff，右上角复选框按等级过滤
6. 危险区可 **重新查重**（换阈值/换模式重跑）或 **删除报告**

### 阈值调节（两种途径）

- **面板临时覆盖**：每次"立即查重/重新查重"表单里的三个数字输入框（0.05–1，自动保证 疑似 ≤ 高度 ≤ 完全相同），随报告快照存档并在报告页展示
- **全局默认**：系统设置 → `setting_sim` 分组（`sim.threshold.identical/high/suspected` 等），对所有新报告生效

## 系统设置（family: `setting_sim`）

| 键 | 默认 | 说明 |
|---|---|---|
| `sim.threshold.identical` | 0.95 | 完全相同阈值 |
| `sim.threshold.high` | 0.75 | 高度相似阈值 |
| `sim.threshold.suspected` | 0.55 | 疑似阈值（低于此不落库） |
| `sim.kgram` | 8 | k-gram 长度（指纹基本单元） |
| `sim.minTokens` | 40 | 代码 token 数下限（防模板/过短误判） |
| `sim.maxCodeSize` | 131072 | 单份代码字节上限 |
| `sim.submissionMode` | latest | 默认取样：latest=每人每题最后一次；all=全部提交 |
| `sim.scope` | both | 自动扫描范围：contest / homework / both |
| `sim.autoScan` | true | 是否启用赛后自动扫描（关闭后仅手动触发） |
| `sim.graceMinutes` | 10 | 赛结束后延迟多少分钟再扫（等补时/复核） |
| `sim.sweepBatch` | 5 | 每小时兜底扫描最多补扫几个比赛 |
| `sim.scanWindowDays` | 90 | 兜底扫描回溯窗口（天） |
| `sim.diffCellLimit` | 4000000 | diff LCS 单元格上限（超过则降级） |

## 数据模型

- `sim.report`：一次扫描（waiting → running → done/failed，CAS 状态机 + lockedAt 心跳，僵死自动回收）
- `sim.pair`：一对相似提交（level 1/2/3、similarity、双方 uid/rid、语言、题目）
- `sim.fingerprint`：rid → k-gram 指纹缓存（BinData 4 字节/哈希），k 或代码变化才重算

## 触发链（全部赛后）

1. `contest/add|edit` → 预约 `sim.scan.precheck` 于 `endAt + grace`；到点校验已结束 → 建报告 → 入队 `sim.scan`
2. `sim.sweep`（每小时，仅实例 0 引导）：回收 running 且心跳超 10 分钟的僵死报告；补扫窗口期内已结束但无成功报告的比赛（每轮 ≤ sweepBatch）
3. 面板手动触发（`@requireSudo`，未结束抛 ContestNotEndedError）

删除域时自动清理三个集合（`domain/delete` 事件）。

## 开发

```bash
yarn install
yarn typecheck   # tsc --noEmit
yarn test        # node --test（tokenizer / fingerprint / dice / lcs 纯模块单测）
```

## E2E 验证步骤

1. 启动 MongoDB 后 `npx hydrooj setup`，`npx hydrooj addon add <本目录>`，`npx hydrooj serve`
2. 用管理员账号建域、建比赛（两题、3+ 用户参赛）、收题
3. 造数据：用户 A/B 提交仅改变量名/注释/缩进的同份代码；用户 C 提交独立写法；A 再交一份逐字相同代码
   - 覆盖两种存码形态：小代码走 `rdoc.code` 内联；大代码走 `rdoc.files.code` + storage
4. 比赛结束后：面板 → 代码查重 → 立即查重（可用默认阈值）
5. 核对：
   - `mongo` 中 `sim.report` 状态 waiting→running→done，stats 合理
   - A-B 疑似/高度、A-A' 完全相同、C 无记录（`sim.pair`）
   - 报告页筛选/分页、diff 页高亮正确
   - `/d/<did>/contest/<tid>/sim` 直接进入该比赛报告
   - 关系网页面渲染、拖拽/缩放/过滤/点边跳 diff 正常；`graph.json` 返回 nodes/edges/problems/stats
6. 性能观察：查重运行期间首页与评测派发无卡顿（worker 即时返回）

## 兼容性说明

- 全部 API 仅使用 hydrooj ≥ 5 plugin-api 导出；模板仅依赖 ui-default 公共布局（`domain_base.html` / `layout/basic.html`）与既有全局（`paginator`/`datetimeSpan`/`url`/`user.render_inline`）
- 比赛管理页侧栏为 ui-default 静态模板（无官方注入点），故按比赛进入使用 `/contest/:tid/sim` 路由别名与面板行内入口；如需在原生侧栏加入口，可自行 override `partials/contest_sidebar_management.html`（本插件刻意不做全局模板覆盖以保证升级兼容）
- PM2 多实例：事件监听全实例注册，定时兜底仅实例 `NODE_APP_INSTANCE=0` 引导
