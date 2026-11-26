# 3-别弄坏 —— 稳定性

**一句话**：原子写、写失败重试、空转检查、不自己重启 DSH

## 本类规矩（摘自 `分类.md`）

- 状态文件原子写（先写临时再换名）
- 写失败重试（占用/权限类错误最多三次）
- 空转检查：连着两轮没改动就停手报卡点
- 自动续跑收紧：欠费、配额、凭证、窗口超限一律不续
- 不自己重启 DSH，让 master 点右上角
- 体检别造假红灯：可选页不在不算问题，指针真指错才算

## 本目录里有什么

| 文件 | 用途 |
| --- | --- |
| `README.md` | 本页 |
| `tools/00-install/check.mjs` | 装机自检：目录、关键文件、依赖是否就位 |
| `tools/00-install/doctor.mjs` | 体检统一入口，四件事一个命令（install / paths / model / bom） |
| `tools/07-sync/bom-check.mjs` | 扫多余 BOM（JSON/JS/YAML 不能带）和含中文 ps1 缺 BOM，`--fix` 自动修 |
| `tools/07-sync/rule-change.mjs` | 改规矩只替换提到的那一段，旧段落存档，其余不动 |
| `tools/07-sync/shared-lock.mjs` | 改 `shared/` 前的写锁（acquire / release，默认 300 秒过期） |
| `tools/07-sync/sync-shared.ps1` | 把工作区同步到 OneDrive / 网络盘，`-DryRun` 先看 |
| `tools/07-sync/sync-workspaces.example.json` | 同步清单示例（加一行多同步一个工作区） |
| `tools/13-model-check/model-check.mjs` | 接新模型前发一句真请求，判断「正文是空的」还是「字被塞进 reasoning」 |
| `tools/16-selfscan/scan-self.mjs` | 上线先扫家底（生图链路、模型、ComfyUI），写回根页 AUTO 区 |
