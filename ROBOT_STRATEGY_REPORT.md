# ROBOT_STRATEGY_REPORT.md — X3 机器人策略报告

## 版本

- **代码版本**: X3 (DifficultyExport v2)
- **校准结果**: 5 关 15 局已通过，机器人目标感知逻辑真实生效

## 策略概述

机器人使用**目标感知一步启发式** (`findBestTargetMove`)：

1. 枚举所有相邻可交换对（右、下，跳过木箱格）
2. 对每对调用 `evaluateSwap` 模拟交换并评分
3. 选最高分交换执行（`Math.random() * 0.5` 扰动打破平分）

## 评分权重表

| 评分项 | 通用基础分 | score | collect | special | ice | crate |
|--------|-----------|-------|---------|---------|-----|-------|
| eliminatedCount | ×10 | +scoreDelta×2 | — | — | — | — |
| specialCreatedCount | ×300 | ×500 | — | ×1200 | — | — |
| specialDetonatedCount | ×500 | ×700 | — | ×1800 | — | — |
| scoreDelta | ×0.1 | — | — | — | — | — |
| targetColorEliminated | — | — | ×1000 | — | — | — |
| iceDamageCount | — | — | — | — | ×1200 | — |
| crateDamageCount | — | — | — | — | — | ×1000 |

## 安全红线实现

### 红线 1：完整还原

grid + tileSpecials 同步交换，try/finally 恢复。异常时也能恢复。

### 红线 2：不触发回调

仅调用 `findMatchGroups()` / `getMostCommonColor()` / `shapeToSpecial()` / `hasCrateAt()`，全部只读。

### 红线 3：特殊交换模拟

与 `triggerSpecialExchange` 完全一致（6 种组合 + 彩球+普通）。

### 红线 4：平分随机选择

`Math.random() * 0.5` 扰动，结构分为整数，不会跨区间。

**注意**：相同棋盘选步不完全可复现，需足够局数消除方差。

## 冰层/木箱规则

- **iceDamageCount**：只统计 eliminatedSet 中本身有冰层的格，不统计四邻
- **crateDamageCount**：四邻 + 直接命中（与 `collectCrateDamageFromDestroyedCells` 一致），Set 去重

## X3 新增导出指标

### 高分关

| 字段 | 说明 |
|------|------|
| `targetScore` | 目标分数 |
| `scores` | 每局最终分数列表 |
| `avgScore` | 平均分 |
| `medianScore` | 中位数 |
| `minScore` | 最低分 |
| `maxScore` | 最高分 |
| `scoreReachedCount` | 达到目标分数的局数 |

### 收集关

| 字段 | 说明 |
|------|------|
| `collectDetail` | 每个目标颜色的平均收集量与需求 |
| 每局 `record.collectDetail` | 每局各颜色最终收集量 |

## 校准结果对比

| 关卡 | 旧机器人 | 目标感知机器人 |
|------|---------|--------------|
| L13 特效 | 1/3，高度随机 | 3/4，胜率 75% |
| L16 冰层教学 | 0/3，平均清 4.3/8 | 3/3，平均剩 15.7 步 |
| L18 特效 | 0/3 | 3/3，平均剩 8.7 步 |
| L20 冰层 Boss | 0/3，进度 50% | 1/7，失败平均进度 88.1% |
| L23 特效+木箱 | 1/3，随机引爆 15 个 | 3/3，进度稳定 |

## 预备调参表（待 59 局结果后统一执行）

| 关卡 | 当前 | 候选 |
|------|------|------|
| L13 | 特效4 / 24步 | 特效5 / 24步 |
| L16 | 冰8 / 28步 | 冰8 / 22步 |
| L18 | 特效4 / 26步 | 特效4 / 23步 |
| L20 | 冰14 / 28步 | 冰14 / 30步 |
| L23 | 特效4 / 27步 | 特效5 / 27步 |
