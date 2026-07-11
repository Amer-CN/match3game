# project-bundle.md — X3 机器人评估器代码包

## 1. findBestTargetMove（Board.ts L2184-L2216）

```typescript
public findBestTargetMove(params: {
    goalType: 'score' | 'collect' | 'special' | 'ice' | 'crate';
    targetColors?: number[];
    targetScore?: number;
    currentScore?: number;
}): { a: { r: number; c: number }; b: { r: number; c: number } } | null {
    const { ROWS, COLS } = Board;
    let best: { a: { r: number; c: number }; b: { r: number; c: number } } | null = null;
    let bestScore = -1;

    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (!this.grid[r] || this.grid[r][c] === undefined) continue;
            if (this.hasCrateAt(r, c)) continue;
            if (this.grid[r][c] < 0) continue;

            // 试右侧
            if (c + 1 < COLS && this.grid[r][c + 1] !== undefined &&
                !this.hasCrateAt(r, c + 1) && this.grid[r][c + 1] >= 0) {
                const score = this.evaluateSwap(r, c, r, c + 1, params);
                if (score > bestScore) { bestScore = score; best = { a: { r, c }, b: { r, c: c + 1 } }; }
            }

            // 试下方
            if (r + 1 < ROWS && this.grid[r + 1] && this.grid[r + 1][c] !== undefined &&
                !this.hasCrateAt(r + 1, c) && this.grid[r + 1][c] >= 0) {
                const score = this.evaluateSwap(r, c, r + 1, c, params);
                if (score > bestScore) { bestScore = score; best = { a: { r, c }, b: { r: r + 1, c } }; }
            }
        }
    }
    return best;
}
```

## 2. evaluateSwap（Board.ts L2218-L2448）

```typescript
private evaluateSwap(
    r1: number, c1: number, r2: number, c2: number,
    params: {
        goalType: 'score' | 'collect' | 'special' | 'ice' | 'crate';
        targetColors?: number[];
        targetScore?: number;
        currentScore?: number;
    },
): number {
    const { ROWS, COLS } = Board;

    // ── 保存原始值 ──
    const va = this.grid[r1][c1];
    const vb = this.grid[r2][c2];
    const sa = this.tileSpecials[r1]?.[c1] ?? SpecialType.NONE;
    const sb = this.tileSpecials[r2]?.[c2] ?? SpecialType.NONE;

    // ── 模拟真实 performSwap：grid + tileSpecials 同步交换 ──
    this.grid[r1][c1] = vb;
    this.grid[r2][c2] = va;
    if (this.tileSpecials[r1]) this.tileSpecials[r1][c1] = sb;
    if (this.tileSpecials[r2]) this.tileSpecials[r2][c2] = sa;

    try {
        // ── 读取交换后的特效（与 triggerSpecialExchange 一致）──
        const specialA = this.tileSpecials[r1]?.[c1] ?? SpecialType.NONE;
        const specialB = this.tileSpecials[r2]?.[c2] ?? SpecialType.NONE;

        const isLine = (s: SpecialType) => s === SpecialType.LINE_H || s === SpecialType.LINE_V;
        const isBomb = (s: SpecialType) => s === SpecialType.BOMB;
        const isColor = (s: SpecialType) => s === SpecialType.COLOR_BOMB;

        const bothSpecial = specialA !== SpecialType.NONE && specialB !== SpecialType.NONE;
        const colorPlusNormal = (isColor(specialA) && specialB === SpecialType.NONE)
                             || (isColor(specialB) && specialA === SpecialType.NONE);
        const isSpecialExchange = bothSpecial || colorPlusNormal;

        let eliminatedCount = 0;
        let specialCreatedCount = 0;
        let specialDetonatedCount = 0;
        let targetColorEliminated = 0;
        let iceDamageCount = 0;
        let crateDamageCount = 0;
        let scoreDelta = 0;

        const eliminatedSet = new Set<string>();
        const addCell = (r: number, c: number) => {
            if (r >= 0 && r < ROWS && c >= 0 && c < COLS) eliminatedSet.add(`${r},${c}`);
        };

        if (isSpecialExchange) {
            if (specialA !== SpecialType.NONE) specialDetonatedCount++;
            if (specialB !== SpecialType.NONE) specialDetonatedCount++;

            if (bothSpecial) {
                if (isLine(specialA) && isLine(specialB)) {
                    for (let cc = 0; cc < COLS; cc++) { addCell(r1, cc); addCell(r2, cc); }
                    for (let rr = 0; rr < ROWS; rr++) { addCell(rr, c1); addCell(rr, c2); }
                } else if (isBomb(specialA) && isBomb(specialB)) {
                    for (let dr = -2; dr <= 2; dr++)
                        for (let dc = -2; dc <= 2; dc++) { addCell(r1 + dr, c1 + dc); addCell(r2 + dr, c2 + dc); }
                } else if ((isBomb(specialA) && isLine(specialB)) || (isLine(specialA) && isBomb(specialB))) {
                    const br = isBomb(specialA) ? r1 : r2;
                    const bc = isBomb(specialA) ? c1 : c2;
                    for (let cc = 0; cc < COLS; cc++)
                        for (let dr = -1; dr <= 1; dr++) addCell(br + dr, cc);
                    for (let rr = 0; rr < ROWS; rr++)
                        for (let dc = -1; dc <= 1; dc++) addCell(rr, bc + dc);
                } else if ((isColor(specialA) && (isLine(specialB) || isBomb(specialB)))
                        || ((isLine(specialA) || isBomb(specialA)) && isColor(specialB))) {
                    const targetColor = this.getMostCommonColor();
                    for (let r = 0; r < ROWS; r++)
                        for (let c = 0; c < COLS; c++)
                            if (this.grid[r] && this.grid[r][c] === targetColor) addCell(r, c);
                    addCell(r1, c1);
                    addCell(r2, c2);
                } else if (isColor(specialA) && isColor(specialB)) {
                    for (let r = 0; r < ROWS; r++)
                        for (let c = 0; c < COLS; c++) addCell(r, c);
                }
            } else if (colorPlusNormal) {
                const bombR = isColor(specialA) ? r1 : r2;
                const bombC = isColor(specialA) ? c1 : c2;
                const normalR = isColor(specialA) ? r2 : r1;
                const normalC = isColor(specialA) ? c2 : c1;
                const targetColor = this.grid[normalR]?.[normalC] ?? this.getMostCommonColor();
                for (let r = 0; r < ROWS; r++)
                    for (let c = 0; c < COLS; c++)
                        if (this.grid[r] && this.grid[r][c] === targetColor) addCell(r, c);
                addCell(bombR, bombC);
            }

            eliminatedCount = eliminatedSet.size;
            scoreDelta = eliminatedCount * 30 + specialDetonatedCount * 300;
        } else {
            const groups = this.findMatchGroups();
            if (groups.length > 0) {
                for (const g of groups) {
                    for (const cell of g.cells) {
                        eliminatedSet.add(`${cell.row},${cell.col}`);
                    }
                    const sp = this.shapeToSpecial(g.shape);
                    if (sp !== SpecialType.NONE) specialCreatedCount++;
                }
                eliminatedCount = eliminatedSet.size;

                if (eliminatedSet.has(`${r1},${c1}`) && specialA !== SpecialType.NONE) specialDetonatedCount++;
                if (eliminatedSet.has(`${r2},${c2}`) && specialB !== SpecialType.NONE) specialDetonatedCount++;

                scoreDelta = eliminatedCount * 30;
                if (specialCreatedCount > 0) scoreDelta += specialCreatedCount * 200;
                if (specialDetonatedCount > 0) scoreDelta += specialDetonatedCount * 300;
            }
        }

        // 目标颜色消除统计
        if (params.targetColors && params.targetColors.length > 0 && eliminatedSet.size > 0) {
            for (const key of eliminatedSet) {
                const [er, ec] = key.split(',').map(Number);
                const colorId = this.grid[er]?.[ec] ?? -1;
                if (params.targetColors.includes(colorId)) {
                    targetColorEliminated++;
                }
            }
        }

        // 冰层伤害：只统计被消除格本身覆盖的冰层
        for (const key of eliminatedSet) {
            const [er, ec] = key.split(',').map(Number);
            if (this.iceLayers[er]?.[ec] > 0) iceDamageCount++;
        }

        // 木箱伤害：四邻 + 直接命中，Set 去重
        {
            const crateHitSet = new Set<string>();
            const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
            for (const key of eliminatedSet) {
                const [er, ec] = key.split(',').map(Number);
                if (this.hasCrateAt(er, ec)) {
                    crateHitSet.add(key);
                } else {
                    for (const [dr, dc] of dirs) {
                        const nr = er + dr;
                        const nc = ec + dc;
                        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
                            if (this.crateLayers[nr]?.[nc] > 0) {
                                crateHitSet.add(`${nr},${nc}`);
                            }
                        }
                    }
                }
            }
            crateDamageCount = crateHitSet.size;
        }

        // 无效交换过滤
        if (eliminatedCount === 0 && specialDetonatedCount === 0) return -1;

        // 综合评分
        let totalScore = 0;
        totalScore += eliminatedCount * 10;
        totalScore += specialCreatedCount * 300;
        totalScore += specialDetonatedCount * 500;
        totalScore += scoreDelta * 0.1;

        switch (params.goalType) {
            case 'score':
                totalScore += scoreDelta * 2;
                totalScore += specialCreatedCount * 500;
                totalScore += specialDetonatedCount * 700;
                break;
            case 'collect':
                totalScore += targetColorEliminated * 1000;
                break;
            case 'special':
                totalScore += specialCreatedCount * 1200;
                totalScore += specialDetonatedCount * 1800;
                break;
            case 'ice':
                totalScore += iceDamageCount * 1200;
                break;
            case 'crate':
                totalScore += crateDamageCount * 1000;
                break;
        }

        totalScore += Math.random() * 0.5;
        return totalScore;
    } finally {
        this.grid[r1][c1] = va;
        this.grid[r2][c2] = vb;
        if (this.tileSpecials[r1]) this.tileSpecials[r1][c1] = sa;
        if (this.tileSpecials[r2]) this.tileSpecials[r2][c2] = sb;
    }
}
```

## 3. triggerSpecialExchange 真实逻辑对照（Board.ts L1518-L1627）

```typescript
// 真实交换在 performSwap 之后调用，此时 tileSpecials 已经交换
private triggerSpecialExchange(a: TileInfo, b: TileInfo): SpecialExchangeResult | null {
    const sa = this.tileSpecials[a.row]?.[a.col] ?? SpecialType.NONE;
    const sb = this.tileSpecials[b.row]?.[b.col] ?? SpecialType.NONE;

    if (sa === SpecialType.NONE && sb === SpecialType.NONE) return null;
    // ...
    // 两个都是特效 → 组合表
    if (sa !== SpecialType.NONE && sb !== SpecialType.NONE) {
        // 线+线 / 炸+炸 / 炸+线 / 彩球+线炸 / 彩球+彩球
        // bp = isBomb(sa) ? a : b  ← 注意：sa 是交换后 a 位置的特效
    }
    // 一个 COLOR_BOMB + 一个普通
    if (isColor(sa) || isColor(sb)) {
        // normalPos = isColor(sa) ? b : a  ← sa 是彩球则 normalPos=b
        // targetColor = this.grid[normalPos.row]?.[normalPos.col]
    }
    // LINE/BOMB + 普通 → return null（走普通匹配）
    return null;
}
```

### 对照要点

| 逻辑点 | triggerSpecialExchange | evaluateSwap | 一致性 |
|--------|----------------------|--------------|--------|
| 读取特效时机 | performSwap 之后 | grid+tileSpecials 同步交换后 | ✅ |
| sa/sb 来源 | `this.tileSpecials[a.row]` | `this.tileSpecials[r1]` | ✅ |
| 线+线范围 | a行+b行 + a列+b列 | r1行+r2行 + c1列+c2列 | ✅ |
| 炸+炸范围 | a±2 + b±2 | r1±2 + r2±2 | ✅ |
| 炸+线中心 | `bp = isBomb(sa) ? a : b` | `br = isBomb(specialA) ? r1 : r2` | ✅ |
| 彩球+普通颜色 | `this.grid[normalPos.row]` | `this.grid[normalR]` | ✅ |
| 彩球+线炸目标色 | `getMostCommonColor()` | `getMostCommonColor()` | ✅ |
| LINE/BOMB+普通 | return null → 普通匹配 | 走 else 分支 → findMatchGroups | ✅ |

## 4. X3 新增：DifficultyExport 字段

### DifficultyRunRecord 新增字段

```typescript
targetScore: number;  // 目标分数（score 类型有值，其余为 0）
collectDetail?: { color: string; have: number; need: number }[];  // collect 详情
```

### DifficultyLevelSummary 新增字段

```typescript
goalType: GoalType;

// 高分关额外指标
targetScore: number;
scores: number[];          // 每局最终分数列表
avgScore: number;
medianScore: number;
minScore: number;
maxScore: number;
scoreReachedCount: number; // 达到目标分数的局数

// 收集关额外指标
collectDetail: { color: string; avgHave: number; need: number }[];
```

### 导出 JSON 版本升级为 version: 2

## 5. 控制台 API

```typescript
(globalThis as any).__MXMH_DIFFICULTY__ = {
    export: () => this.exportDifficultyTestReport(),
    summary: () => this.printDifficultySummary(),
    clear: () => this.clearDifficultyTestData(),
    autorun: () => this.startAutoTestRun(),
    testrun: (levels: number[], runs: number = 3) => this.startTargetedTestRun(levels, runs),
    batchtest: (groups: { levels: number[]; runs: number }[]) => this.startBatchTestRun(groups),
    stop: () => this.stopAutoTest(),
};
```

## 6. 机器人代码不影响正常玩家流程的证明

`evaluateSwap` 和 `findBestTargetMove` 仅在 `autoTestTick` 中被调用。

`autoTestTick` 仅在 `_autoTestRunning === true` 时执行，该标志只在 `startAutoTestRun` / `startTargetedTestRun` / `startBatchTestRun` 中设为 true。

正常玩家流程：
1. 玩家滑动 → `TileGesture` → `trySwapByDir` → `swapWithCheck` → `performSwap` + `triggerSpecialExchange`
2. 不经过 `findBestTargetMove` / `evaluateSwap`

`evaluateSwap` 修改的字段：
- `this.grid[r1][c1]` / `this.grid[r2][c2]` → try/finally 恢复
- `this.tileSpecials[r1][c1]` / `this.tileSpecials[r2][c2]` → try/finally 恢复
- 不修改 `tiles` / `tileInfoMap` / `iceLayers` / `crateLayers` / `_activatedSpecials` / `totalScore` / `callbacks`
