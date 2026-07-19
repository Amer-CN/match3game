/**
 * SaveManager — 进度存档持久化单例（纯数据，非 Component）
 *
 * 三级存储策略：
 *   1. wx.setStorageSync / getStorageSync（微信小游戏）
 *   2. localStorage（浏览器 / 开发者工具）
 *   3. 内存对象兜底（以上都不可用时）
 *
 * 所有异常 try/catch 吞掉，绝不抛错。
 */

// 微信小游戏全局 API
declare const wx: any;

// ── 道具类型（Y1） ─────────────────────────────

export type BoosterType =
    | 'hammer'
    | 'shuffle'
    | 'addSteps';

export interface BoosterInventory {
    hammer: number;
    shuffle: number;
    addSteps: number;
}

// ── 广告位类型（Y2） ─────────────────────────────

export type RewardedAdPlacement =
    | 'continue'
    | 'gacha'
    | 'boosterHammer'
    | 'boosterShuffle'
    | 'boosterAddSteps'
    | 'resultScore'
    | 'resultCoins';

export interface DailyAdUsage {
    date: string;
    continue: number;
    gacha: number;
    boosterHammer: number;
    boosterShuffle: number;
    boosterAddSteps: number;
    resultScore: number;
    resultCoins: number;
}

// ── 存档结构 ────────────────────────────────

interface LevelRecord {
    cleared: boolean;
    bestScore: number;
}

/** 怪物收藏记录（monId 0-5：0兔/1熊/2象/3鹿/4龙/5狐） */
interface MonsterRecord {
    count: number;  // 拥有数量
    star: number;   // 星级 1-5
}

interface SaveData {
    maxUnlockedLevel: number;
    levelRecords: { [level: number]: LevelRecord };
    gachaCoins: number;                          // 扭蛋币余额（E0）
    collection: { [monId: number]: MonsterRecord }; // 怪物收藏（E0）
    // Q0: 装扮系统字段
    equippedTheme: number;                       // 当前装备的主题 id（默认 0）
    ownedThemes: number[];                       // 已拥有的主题列表（默认 [0]）
    equippedAccessory: number;                   // 当前装备的配饰 id（-1=无）
    ownedAccessories: number[];                  // 已拥有的配饰列表（默认 []）
    // R0: 设置 + 签到字段
    soundEnabled: boolean;                       // 音效开关（默认 true）
    vibrateEnabled: boolean;                     // 震动开关（默认 true）
    signStreak: number;                          // 连续签到天数（默认 0）
    lastSignDate: string;                        // 上次签到日期 YYYY-MM-DD（默认 ''）
    signedTotal: number;                         // 累计签到天数（默认 0）
    // Y1: 道具库存
    boosters: BoosterInventory;                  // 持久化道具库存
    // Y2: 每日广告使用记录
    dailyAdUsage: DailyAdUsage;
    // Y3.0: 连胜 / 宝箱 / 保护
    winStreak: number;                           // 当前连续通关数
    streakShieldDate: string;                    // 最近一次使用连胜保护广告的日期 YYYY-MM-DD
    streakShieldUsedToday: boolean;              // 当天是否已使用过连胜保护
    chapterChestClaims: { [chapter: number]: boolean }; // 章节宝箱领取记录
}

// ── 常量 ────────────────────────────────────

const SAVE_KEY = 'mxmh_save_v1';

function createDefaultSave(): SaveData {
    return {
        maxUnlockedLevel: 1,
        levelRecords: {},
        gachaCoins: 0,
        collection: {},
        equippedTheme: 0,
        ownedThemes: [0],
        equippedAccessory: -1,
        ownedAccessories: [],
        soundEnabled: true,
        vibrateEnabled: true,
        signStreak: 0,
        lastSignDate: '',
        signedTotal: 0,
        boosters: {
            hammer: 2,
            shuffle: 2,
            addSteps: 2,
        },
        dailyAdUsage: {
            date: '',
            continue: 0,
            gacha: 0,
            boosterHammer: 0,
            boosterShuffle: 0,
            boosterAddSteps: 0,
            resultScore: 0,
            resultCoins: 0,
        },
        // Y3.0: 连胜 / 宝箱 / 保护 默认值
        winStreak: 0,
        streakShieldDate: '',
        streakShieldUsedToday: false,
        chapterChestClaims: {},
    };
}

// ── 单例 ────────────────────────────────────

export class SaveManager {
    private static _inst: SaveManager | null = null;
    static get inst(): SaveManager {
        if (!SaveManager._inst) SaveManager._inst = new SaveManager();
        return SaveManager._inst;
    }

    private _data: SaveData = createDefaultSave();
    private _loaded = false;

    // 存储后端类型（诊断用）
    private _backend: 'wx' | 'localStorage' | 'memory' = 'memory';

    private constructor() {
        this.load();
    }

    // ── 底层读写 ────────────────────────────────

    private _readRaw(): string | null {
        // 1. 微信
        try {
            if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
                this._backend = 'wx';
                const val = wx.getStorageSync(SAVE_KEY);
                // wx 返回 '' 表示无数据
                if (val !== '' && val !== undefined && val !== null) return String(val);
                return null;
            }
        } catch (e) { /* swallow */ }

        // 2. localStorage
        try {
            if (typeof localStorage !== 'undefined') {
                this._backend = 'localStorage';
                const val = localStorage.getItem(SAVE_KEY);
                return val;
            }
        } catch (e) { /* swallow */ }

        // 3. 内存
        this._backend = 'memory';
        return null;
    }

    private _writeRaw(str: string): void {
        // 1. 微信
        try {
            if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
                wx.setStorageSync(SAVE_KEY, str);
                return;
            }
        } catch (e) { /* swallow */ }

        // 2. localStorage
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(SAVE_KEY, str);
                return;
            }
        } catch (e) { /* swallow */ }

        // 3. 内存（写回 _data 即可，下次读内存里的）
    }

    // ── 公开 API ────────────────────────────────

    /** 读取存档并缓存到内存（缺失/脏数据回退默认） */
    load(): SaveData {
        if (this._loaded) return this._data;
        this._loaded = true;

        const raw = this._readRaw();
        if (!raw) {
            this._data = createDefaultSave();
            console.log(`[SaveManager] 无存档，使用默认值 (backend=${this._backend})`);
            return this._data;
        }

        try {
            const parsed = JSON.parse(raw) as Partial<SaveData>;
            this._data = this._sanitize(parsed);
            console.log(
                `[SaveManager] 存档已加载 (backend=${this._backend}): ` +
                `maxUnlocked=${this._data.maxUnlockedLevel}, ` +
                `records=${Object.keys(this._data.levelRecords).length} 关, ` +
                `coins=${this._data.gachaCoins}, ` +
                `collection=${Object.keys(this._data.collection).length} 种`,
            );
        } catch (e) {
            console.warn('[SaveManager] 存档解析失败，回退默认:', e);
            this._data = createDefaultSave();
        }

        return this._data;
    }

    /** 数据清洗：脏数据/NaN 一律回退默认 */
    private _sanitize(parsed: Partial<SaveData>): SaveData {
        const result = createDefaultSave();

        // maxUnlockedLevel
        const mul = parsed.maxUnlockedLevel;
        if (typeof mul === 'number' && !isNaN(mul) && isFinite(mul) && mul >= 1) {
            result.maxUnlockedLevel = Math.floor(mul);
        }

        // levelRecords
        if (parsed.levelRecords && typeof parsed.levelRecords === 'object') {
            for (const key of Object.keys(parsed.levelRecords)) {
                const levelNum = parseInt(key, 10);
                if (isNaN(levelNum) || levelNum < 1) continue;

                const rec = parsed.levelRecords[key];
                if (!rec || typeof rec !== 'object') continue;

                const cleared = rec.cleared === true;
                const bestScore = (typeof rec.bestScore === 'number' && !isNaN(rec.bestScore) && isFinite(rec.bestScore))
                    ? Math.max(0, Math.floor(rec.bestScore))
                    : 0;

                result.levelRecords[levelNum] = { cleared, bestScore };
            }
        }

        // gachaCoins（E0：向后兼容，老存档无此字段则默认 0）
        const coins = parsed.gachaCoins;
        if (typeof coins === 'number' && !isNaN(coins) && isFinite(coins) && coins >= 0) {
            result.gachaCoins = Math.floor(coins);
        }

        // collection（E0：向后兼容，老存档无此字段则默认空）
        if (parsed.collection && typeof parsed.collection === 'object') {
            for (const key of Object.keys(parsed.collection)) {
                const monId = parseInt(key, 10);
                if (isNaN(monId) || monId < 0 || monId > 5) continue;

                const rec = parsed.collection[key];
                if (!rec || typeof rec !== 'object') continue;

                const count = (typeof rec.count === 'number' && !isNaN(rec.count) && isFinite(rec.count) && rec.count >= 0)
                    ? Math.floor(rec.count) : 0;
                const star = (typeof rec.star === 'number' && !isNaN(rec.star) && isFinite(rec.star) && rec.star >= 1 && rec.star <= 5)
                    ? Math.floor(rec.star) : 1;

                // count > 0 才记录（count=0 不入库，getMonster 会返回默认）
                if (count > 0) {
                    result.collection[monId] = { count, star };
                }
            }
        }

        // Q0: 装扮系统字段（向后兼容，老存档无则补默认）
        const equippedTheme = (typeof parsed.equippedTheme === 'number' && !isNaN(parsed.equippedTheme) && isFinite(parsed.equippedTheme))
            ? Math.floor(parsed.equippedTheme) : 0;
        const ownedThemes = (Array.isArray(parsed.ownedThemes))
            ? parsed.ownedThemes.filter((t: any) => typeof t === 'number' && !isNaN(t) && isFinite(t)).map((t: number) => Math.floor(t))
            : [0];
        // equippedTheme 必须在 ownedThemes 内，否则回退 0
        result.equippedTheme = ownedThemes.includes(equippedTheme) ? equippedTheme : 0;
        // 确保 ownedThemes 至少含 0
        if (!ownedThemes.includes(0)) ownedThemes.push(0);
        result.ownedThemes = ownedThemes;

        const equippedAccessory = (typeof parsed.equippedAccessory === 'number' && !isNaN(parsed.equippedAccessory) && isFinite(parsed.equippedAccessory))
            ? Math.floor(parsed.equippedAccessory) : -1;
        const ownedAccessories = (Array.isArray(parsed.ownedAccessories))
            ? parsed.ownedAccessories.filter((a: any) => typeof a === 'number' && !isNaN(a) && isFinite(a)).map((a: number) => Math.floor(a))
            : [];
        // equippedAccessory 必须在 ownedAccessories 内（-1 表示无配饰，永远合法）
        result.equippedAccessory = (equippedAccessory === -1 || ownedAccessories.includes(equippedAccessory)) ? equippedAccessory : -1;
        result.ownedAccessories = ownedAccessories;

        // R0: 设置 + 签到字段（向后兼容，老存档无则补默认）
        result.soundEnabled = (typeof parsed.soundEnabled === 'boolean') ? parsed.soundEnabled : true;
        result.vibrateEnabled = (typeof parsed.vibrateEnabled === 'boolean') ? parsed.vibrateEnabled : true;

        // signStreak: 非数/NaN → 0，越界 clamp 0-7
        const rawStreak = parsed.signStreak;
        if (typeof rawStreak === 'number' && !isNaN(rawStreak) && isFinite(rawStreak)) {
            result.signStreak = Math.max(0, Math.min(7, Math.floor(rawStreak)));
        } else {
            result.signStreak = 0;
        }

        // lastSignDate: 非字符串 → ''
        result.lastSignDate = (typeof parsed.lastSignDate === 'string') ? parsed.lastSignDate : '';

        // signedTotal: 负/NaN/非数 → 0
        const rawTotal = parsed.signedTotal;
        if (typeof rawTotal === 'number' && !isNaN(rawTotal) && isFinite(rawTotal) && rawTotal >= 0) {
            result.signedTotal = Math.floor(rawTotal);
        } else {
            result.signedTotal = 0;
        }

        // Y1: 道具库存清洗（向后兼容，老存档无则补默认 {2,2,2}）
        const rawBoosters =
            parsed.boosters &&
            typeof parsed.boosters === 'object'
                ? parsed.boosters
                : null;

        if (rawBoosters) {
            result.boosters = {
                hammer: this._sanitizeBoosterCount(
                    (rawBoosters as any).hammer,
                    2,
                ),
                shuffle: this._sanitizeBoosterCount(
                    (rawBoosters as any).shuffle,
                    2,
                ),
                addSteps: this._sanitizeBoosterCount(
                    (rawBoosters as any).addSteps,
                    2,
                ),
            };
        }

        // Y2: 每日广告使用记录清洗（向后兼容，老存档无则补默认）
        const rawAdUsage =
            parsed.dailyAdUsage &&
            typeof parsed.dailyAdUsage === 'object'
                ? parsed.dailyAdUsage as any
                : null;

        if (rawAdUsage) {
            result.dailyAdUsage = {
                date: (typeof rawAdUsage.date === 'string') ? rawAdUsage.date : '',
                continue: this._sanitizeAdCount(rawAdUsage.continue),
                gacha: this._sanitizeAdCount(rawAdUsage.gacha),
                boosterHammer: this._sanitizeAdCount(rawAdUsage.boosterHammer),
                boosterShuffle: this._sanitizeAdCount(rawAdUsage.boosterShuffle),
                boosterAddSteps: this._sanitizeAdCount(rawAdUsage.boosterAddSteps),
                resultScore: this._sanitizeAdCount(rawAdUsage.resultScore),
                resultCoins: this._sanitizeAdCount(rawAdUsage.resultCoins),
            };
        }

        // Y3.0: 连胜 / 宝箱 / 保护 清洗（向后兼容，老存档无则补默认）

        // winStreak: 有限非负数字，向下取整，clamp 0-9999
        const rawWinStreak = parsed.winStreak;
        if (typeof rawWinStreak === 'number' && !isNaN(rawWinStreak) && isFinite(rawWinStreak) && rawWinStreak >= 0) {
            result.winStreak = Math.min(9999, Math.floor(rawWinStreak));
        } else {
            result.winStreak = 0;
        }

        // streakShieldDate: 只接受 string
        result.streakShieldDate = (typeof parsed.streakShieldDate === 'string') ? parsed.streakShieldDate : '';

        // streakShieldUsedToday: 只接受严格 boolean
        result.streakShieldUsedToday = (parsed.streakShieldUsedToday === true);

        // chapterChestClaims: 只接受对象；键须为严格正整数字符串；值仅 true 才保留
        if (parsed.chapterChestClaims && typeof parsed.chapterChestClaims === 'object') {
            for (const key of Object.keys(parsed.chapterChestClaims)) {
                // 仅接受规范的正整数字符串键（拒绝 "01"、"1.5"、"1abc"、"1e3"、"-1"、"NaN" 等）
                if (!/^[1-9]\d*$/.test(key)) continue;
                const chapterNum = Number(key);
                if (!Number.isSafeInteger(chapterNum) || chapterNum < 1) continue;
                if ((parsed.chapterChestClaims as any)[key] === true) {
                    result.chapterChestClaims[chapterNum] = true;
                }
            }
        }

        return result;
    }

    /** Y2: 广告计数清洗 — NaN/Infinity → 0，负数 → 0，小数向下取整，最大 99 */
    private _sanitizeAdCount(value: unknown): number {
        if (
            typeof value !== 'number' ||
            !isFinite(value) ||
            isNaN(value)
        ) {
            return 0;
        }
        return Math.max(0, Math.min(99, Math.floor(value)));
    }

    /** Y1: 道具数量清洗 — NaN/Infinity 回退，clamp 0-99 */
    private _sanitizeBoosterCount(
        value: unknown,
        fallback: number,
    ): number {
        if (
            typeof value !== 'number' ||
            !isFinite(value) ||
            isNaN(value)
        ) {
            return fallback;
        }

        return Math.max(
            0,
            Math.min(99, Math.floor(value)),
        );
    }

    /** 获取当前最大已解锁关卡（至少为 1） */
    getMaxUnlocked(): number {
        this.load();
        return Math.max(1, this._data.maxUnlockedLevel);
    }

    /** 判断某关是否已通关 */
    isCleared(level: number): boolean {
        this.load();
        const rec = this._data.levelRecords[level];
        return rec ? rec.cleared : false;
    }

    /** 获取某关最高分（未通关返回 0） */
    getBestScore(level: number): number {
        this.load();
        const rec = this._data.levelRecords[level];
        return rec ? rec.bestScore : 0;
    }

    /**
     * 标记某关已通关，更新最高分，解锁下一关，立即写盘。
     * @param level  关卡编号（1~N）
     * @param score  本关得分
     */
    markCleared(level: number, score: number): void {
        this.load();

        // 防护
        const safeLevel = (typeof level === 'number' && !isNaN(level) && isFinite(level) && level >= 1)
            ? Math.floor(level) : 1;
        const safeScore = (typeof score === 'number' && !isNaN(score) && isFinite(score))
            ? Math.max(0, Math.floor(score)) : 0;

        // 更新通关记录
        const existing = this._data.levelRecords[safeLevel] ?? { cleared: false, bestScore: 0 };
        existing.cleared = true;
        existing.bestScore = Math.max(existing.bestScore, safeScore);
        this._data.levelRecords[safeLevel] = existing;

        // 解锁下一关
        const nextLevel = safeLevel + 1;
        if (nextLevel > this._data.maxUnlockedLevel) {
            this._data.maxUnlockedLevel = nextLevel;
        }

        // 立即写盘
        this._flush();

        console.log(
            `[SaveManager] markCleared: level=${safeLevel} score=${safeScore} ` +
            `→ maxUnlocked=${this._data.maxUnlockedLevel} ` +
            `best=${existing.bestScore} cleared=${existing.cleared}`,
        );
    }

    // ── 扭蛋币 API（E0） ─────────────────────────

    /** 获取扭蛋币余额 */
    getCoins(): number {
        this.load();
        return Math.max(0, this._data.gachaCoins);
    }

    /** 增加扭蛋币 */
    addCoins(n: number): void {
        this.load();
        const safeN = (typeof n === 'number' && !isNaN(n) && isFinite(n))
            ? Math.max(0, Math.floor(n)) : 0;
        if (safeN <= 0) return;
        this._data.gachaCoins += safeN;
        this._flush();
        console.log(`[SaveManager] addCoins(+${safeN}) → 余额=${this._data.gachaCoins}`);
    }

    /** 消费扭蛋币（不足返回 false 不扣） */
    spendCoins(n: number): boolean {
        this.load();
        const safeN = (typeof n === 'number' && !isNaN(n) && isFinite(n))
            ? Math.max(0, Math.floor(n)) : 0;
        if (safeN <= 0) return true;
        if (this._data.gachaCoins < safeN) return false;
        this._data.gachaCoins -= safeN;
        this._flush();
        console.log(`[SaveManager] spendCoins(-${safeN}) → 余额=${this._data.gachaCoins}`);
        return true;
    }

    // ── 怪物收藏 API（E0） ────────────────────────

    /** 获取整个收藏表（只读引用，外部不应修改） */
    getCollection(): { [monId: number]: MonsterRecord } {
        this.load();
        return this._data.collection;
    }

    /** 获取某怪物记录（未拥有返回 {count:0, star:0}） */
    getMonster(id: number): MonsterRecord {
        this.load();
        const safeId = this._safeMonId(id);
        const rec = this._data.collection[safeId];
        return rec ? { count: rec.count, star: rec.star } : { count: 0, star: 0 };
    }

    /** 增加一个怪物（count+1，首次获得 star 置 1，立即写盘） */
    addMonster(id: number): void {
        this.load();
        const safeId = this._safeMonId(id);
        const existing = this._data.collection[safeId];
        if (existing) {
            existing.count += 1;
        } else {
            this._data.collection[safeId] = { count: 1, star: 1 };
        }
        this._flush();
        const rec = this._data.collection[safeId];
        console.log(`[SaveManager] addMonster(id=${safeId}) → count=${rec.count} star=${rec.star}`);
    }

    /** 升星（count>=3 时 count-=3、star+1(上限5)、写盘返回 true，否则 false） */
    upgradeStar(id: number): boolean {
        this.load();
        const safeId = this._safeMonId(id);
        const rec = this._data.collection[safeId];
        if (!rec || rec.count < 3) return false;
        if (rec.star >= 5) return false;
        rec.count -= 3;
        rec.star += 1;
        // count 降到 0 时不删除记录（保留 star 信息）
        this._flush();
        console.log(`[SaveManager] upgradeStar(id=${safeId}) → count=${rec.count} star=${rec.star}`);
        return true;
    }

    // ── 收藏内部工具 ──────────────────────────────

    /** monId 安全校验（0-5，非法回退 0） */
    private _safeMonId(id: number): number {
        if (typeof id === 'number' && !isNaN(id) && isFinite(id) && id >= 0 && id <= 5) {
            return Math.floor(id);
        }
        return 0;
    }

    /** 仅更新最高分（不改变通关状态/解锁），用于失败时也记录 bestScore */
    updateBestScore(level: number, score: number): void {
        this.load();

        const safeLevel = (typeof level === 'number' && !isNaN(level) && isFinite(level) && level >= 1)
            ? Math.floor(level) : 1;
        const safeScore = (typeof score === 'number' && !isNaN(score) && isFinite(score))
            ? Math.max(0, Math.floor(score)) : 0;

        const existing = this._data.levelRecords[safeLevel] ?? { cleared: false, bestScore: 0 };
        if (safeScore > existing.bestScore) {
            existing.bestScore = safeScore;
            this._data.levelRecords[safeLevel] = existing;
            this._flush();
        }
    }

    /** 调试用：清空所有存档 */
    resetAll(): void {
        this._data = createDefaultSave();
        this._flush();
        console.log('[SaveManager] 存档已清空');
    }

    /** 调试用：强制从存储重新加载（用于测试后恢复） */
    reload(): void {
        this._loaded = false;
        this.load();
    }

    // ── 装扮系统 API（Q0） ───────────────────────

    /** 获取当前装备的主题 id */
    getEquippedTheme(): number {
        this.load();
        return this._data.equippedTheme;
    }

    /** 设置当前装备的主题 id（必须已拥有，每次写盘） */
    setEquippedTheme(id: number): void {
        this.load();
        const safeId = (typeof id === 'number' && !isNaN(id) && isFinite(id) && id >= 0 && id <= 3) ? Math.floor(id) : 0;
        if (!this._data.ownedThemes.includes(safeId)) return;
        this._data.equippedTheme = safeId;
        this._flush();
    }

    /** 获取已拥有的主题列表 */
    getOwnedThemes(): number[] {
        this.load();
        return [...this._data.ownedThemes];
    }

    /** 拥有某主题（加入列表并写盘） */
    ownTheme(id: number): void {
        this.load();
        const safeId = (typeof id === 'number' && !isNaN(id) && isFinite(id) && id >= 0 && id <= 3) ? Math.floor(id) : 0;
        if (!this._data.ownedThemes.includes(safeId)) {
            this._data.ownedThemes.push(safeId);
            this._flush();
        }
    }

    /** 获取当前装备的配饰 id（-1=无） */
    getEquippedAccessory(): number {
        this.load();
        return this._data.equippedAccessory;
    }

    /** 设置当前装备的配饰 id（必须已拥有，-1 表示取下，每次写盘） */
    setEquippedAccessory(id: number): void {
        this.load();
        const safeId = (typeof id === 'number' && !isNaN(id) && isFinite(id) && id >= -1 && id <= 2) ? Math.floor(id) : -1;
        if (safeId !== -1 && !this._data.ownedAccessories.includes(safeId)) return;
        this._data.equippedAccessory = safeId;
        this._flush();
    }

    /** 获取已拥有的配饰列表 */
    getOwnedAccessories(): number[] {
        this.load();
        return [...this._data.ownedAccessories];
    }

    /** 拥有某配饰（加入列表并写盘） */
    ownAccessory(id: number): void {
        this.load();
        const safeId = (typeof id === 'number' && !isNaN(id) && isFinite(id) && id >= 0 && id <= 2) ? Math.floor(id) : 0;
        if (!this._data.ownedAccessories.includes(safeId)) {
            this._data.ownedAccessories.push(safeId);
            this._flush();
        }
    }

    // ── 设置 + 签到 API（R0） ─────────────────────

    /** 获取音效开关 */
    getSoundEnabled(): boolean {
        this.load();
        return this._data.soundEnabled;
    }

    /** 设置音效开关并写盘 */
    setSoundEnabled(enabled: boolean): void {
        this.load();
        this._data.soundEnabled = (enabled === true);
        this._flush();
    }

    /** 获取震动开关 */
    getVibrateEnabled(): boolean {
        this.load();
        return this._data.vibrateEnabled;
    }

    /** 设置震动开关并写盘 */
    setVibrateEnabled(enabled: boolean): void {
        this.load();
        this._data.vibrateEnabled = (enabled === true);
        this._flush();
    }

    /** 获取签到数据 */
    getSignData(): { streak: number; lastDate: string; total: number } {
        this.load();
        return {
            streak: this._data.signStreak,
            lastDate: this._data.lastSignDate,
            total: this._data.signedTotal,
        };
    }

    /** 写入签到数据并写盘 */
    writeSignData(streak: number, dateStr: string, total: number): void {
        this.load();
        // streak clamp 0-7
        this._data.signStreak = (typeof streak === 'number' && !isNaN(streak) && isFinite(streak))
            ? Math.max(0, Math.min(7, Math.floor(streak))) : 0;
        // dateStr 必须是字符串
        this._data.lastSignDate = (typeof dateStr === 'string') ? dateStr : '';
        // total 非负整数
        this._data.signedTotal = (typeof total === 'number' && !isNaN(total) && isFinite(total) && total >= 0)
            ? Math.floor(total) : 0;
        this._flush();
    }

    // ── 道具库存 API（Y1） ───────────────────────

    /** 获取道具库存副本（不暴露内部引用） */
    getBoosterInventory(): BoosterInventory {
        this.load();
        return {
            hammer: this._data.boosters.hammer,
            shuffle: this._data.boosters.shuffle,
            addSteps: this._data.boosters.addSteps,
        };
    }

    /** 获取指定道具数量 */
    getBoosterCount(type: BoosterType): number {
        this.load();
        switch (type) {
            case 'hammer': return this._data.boosters.hammer;
            case 'shuffle': return this._data.boosters.shuffle;
            case 'addSteps': return this._data.boosters.addSteps;
            default: return 0;
        }
    }

    /** 增加道具（clamp 到 99，立即写盘） */
    addBooster(type: BoosterType, amount: number = 1): void {
        this.load();
        if (typeof amount !== 'number' || !isFinite(amount) || isNaN(amount) || amount <= 0) return;
        const add = Math.floor(amount);
        if (add <= 0) return;

        switch (type) {
            case 'hammer':
                this._data.boosters.hammer = Math.min(99, this._data.boosters.hammer + add);
                break;
            case 'shuffle':
                this._data.boosters.shuffle = Math.min(99, this._data.boosters.shuffle + add);
                break;
            case 'addSteps':
                this._data.boosters.addSteps = Math.min(99, this._data.boosters.addSteps + add);
                break;
            default:
                return;
        }
        this._flush();
        console.log(`[SaveManager] addBooster(${type},+${add}) → ${this.getBoosterCount(type)}`);
    }

    /** 消耗道具（不足返回 false 不扣，成功返回 true） */
    spendBooster(type: BoosterType, amount: number = 1): boolean {
        this.load();
        if (typeof amount !== 'number' || !isFinite(amount) || isNaN(amount) || amount <= 0) return false;
        const cost = Math.floor(amount);
        if (cost <= 0) return false;

        const current = this.getBoosterCount(type);
        if (current < cost) return false;

        switch (type) {
            case 'hammer':
                this._data.boosters.hammer = Math.max(0, this._data.boosters.hammer - cost);
                break;
            case 'shuffle':
                this._data.boosters.shuffle = Math.max(0, this._data.boosters.shuffle - cost);
                break;
            case 'addSteps':
                this._data.boosters.addSteps = Math.max(0, this._data.boosters.addSteps - cost);
                break;
            default:
                return false;
        }
        this._flush();
        console.log(`[SaveManager] spendBooster(${type},-${cost}) → ${this.getBoosterCount(type)}`);
        return true;
    }

    // ── 每日广告频控 API（Y2） ───────────────────

    /** 每日广告上限 */
    private static readonly DAILY_AD_CAPS: Record<RewardedAdPlacement, number> = {
        continue: 3,
        gacha: 1,
        boosterHammer: 1,
        boosterShuffle: 1,
        boosterAddSteps: 1,
        resultScore: 1,
        resultCoins: 2,
    };

    /** 获取本地日期字符串 YYYY-MM-DD（不使用 UTC，避免北京时间错位） */
    private _getTodayStr(): string {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    /** 跨天自动重置每日广告计数 */
    private _ensureDailyAdDate(): void {
        const today = this._getTodayStr();
        if (this._data.dailyAdUsage.date !== today) {
            this._data.dailyAdUsage = {
                date: today,
                continue: 0,
                gacha: 0,
                boosterHammer: 0,
                boosterShuffle: 0,
                boosterAddSteps: 0,
                resultScore: 0,
                resultCoins: 0,
            };
            this._flush();
        }
    }

    /** 获取每日广告使用记录副本（不暴露内部引用） */
    getDailyAdUsage(): DailyAdUsage {
        this.load();
        this._ensureDailyAdDate();
        return {
            date: this._data.dailyAdUsage.date,
            continue: this._data.dailyAdUsage.continue,
            gacha: this._data.dailyAdUsage.gacha,
            boosterHammer: this._data.dailyAdUsage.boosterHammer,
            boosterShuffle: this._data.dailyAdUsage.boosterShuffle,
            boosterAddSteps: this._data.dailyAdUsage.boosterAddSteps,
            resultScore: this._data.dailyAdUsage.resultScore,
            resultCoins: this._data.dailyAdUsage.resultCoins,
        };
    }

    /** 获取指定广告位今日已使用次数 */
    getRewardedAdCount(placement: RewardedAdPlacement): number {
        this.load();
        this._ensureDailyAdDate();
        switch (placement) {
            case 'continue': return this._data.dailyAdUsage.continue;
            case 'gacha': return this._data.dailyAdUsage.gacha;
            case 'boosterHammer': return this._data.dailyAdUsage.boosterHammer;
            case 'boosterShuffle': return this._data.dailyAdUsage.boosterShuffle;
            case 'boosterAddSteps': return this._data.dailyAdUsage.boosterAddSteps;
            case 'resultScore': return this._data.dailyAdUsage.resultScore;
            case 'resultCoins': return this._data.dailyAdUsage.resultCoins;
            default: return 0;
        }
    }

    /** 获取指定广告位今日剩余次数 */
    getRewardedAdRemaining(placement: RewardedAdPlacement): number {
        const cap = SaveManager.DAILY_AD_CAPS[placement] ?? 0;
        const used = this.getRewardedAdCount(placement);
        return Math.max(0, cap - used);
    }

    /** 判断指定广告位今日是否还可使用 */
    canUseRewardedAd(placement: RewardedAdPlacement): boolean {
        const cap = SaveManager.DAILY_AD_CAPS[placement] ?? 0;
        const used = this.getRewardedAdCount(placement);
        return used < cap;
    }

    /**
     * 记录一次广告成功完成（+1 并写盘）。
     * 只在广告成功完成后调用；未看完/关闭/失败时不调用。
     * 已达上限返回 false，成功返回 true。
     */
    recordRewardedAd(placement: RewardedAdPlacement): boolean {
        this.load();
        this._ensureDailyAdDate();
        const cap = SaveManager.DAILY_AD_CAPS[placement] ?? 0;
        switch (placement) {
            case 'continue':
                if (this._data.dailyAdUsage.continue >= cap) return false;
                this._data.dailyAdUsage.continue += 1;
                break;
            case 'gacha':
                if (this._data.dailyAdUsage.gacha >= cap) return false;
                this._data.dailyAdUsage.gacha += 1;
                break;
            case 'boosterHammer':
                if (this._data.dailyAdUsage.boosterHammer >= cap) return false;
                this._data.dailyAdUsage.boosterHammer += 1;
                break;
            case 'boosterShuffle':
                if (this._data.dailyAdUsage.boosterShuffle >= cap) return false;
                this._data.dailyAdUsage.boosterShuffle += 1;
                break;
            case 'boosterAddSteps':
                if (this._data.dailyAdUsage.boosterAddSteps >= cap) return false;
                this._data.dailyAdUsage.boosterAddSteps += 1;
                break;
            case 'resultScore':
                if (this._data.dailyAdUsage.resultScore >= cap) return false;
                this._data.dailyAdUsage.resultScore += 1;
                break;
            case 'resultCoins':
                if (this._data.dailyAdUsage.resultCoins >= cap) return false;
                this._data.dailyAdUsage.resultCoins += 1;
                break;
            default:
                return false;
        }
        this._flush();
        console.log(`[SaveManager] recordRewardedAd(${placement}) → ${this.getRewardedAdCount(placement)}/${cap}`);
        return true;
    }

    // ── 连胜 / 宝箱 / 保护 API（Y3.0） ─────────────

    /** 获取当前连胜数（安全值） */
    getWinStreak(): number {
        this.load();
        return this._data.winStreak;
    }

    /** 连胜 +1（clamp 9999），写盘，返回新值 */
    incrementWinStreak(): number {
        this.load();
        this._data.winStreak = Math.min(9999, this._data.winStreak + 1);
        this._flush();
        console.log(`[SaveManager] incrementWinStreak → ${this._data.winStreak}`);
        return this._data.winStreak;
    }

    /** 连胜清零，写盘 */
    resetWinStreak(): void {
        this.load();
        this._data.winStreak = 0;
        this._flush();
        console.log('[SaveManager] resetWinStreak → 0');
    }

    /** 连胜保护跨天重置：日期不是今天时，streakShieldUsedToday 置 false（不重置 winStreak，不影响 dailyAdUsage） */
    private _ensureStreakShieldDate(): void {
        const today = this._getTodayStr();
        if (this._data.streakShieldDate !== today) {
            this._data.streakShieldDate = today;
            this._data.streakShieldUsedToday = false;
            this._flush();
        }
    }

    /** 判断今天是否仍可使用一次连胜保护 */
    canUseStreakShieldToday(): boolean {
        this.load();
        this._ensureStreakShieldDate();
        return !this._data.streakShieldUsedToday;
    }

    /**
     * 记录一次连胜保护使用。
     * 当天未使用：写入今天日期、置 usedToday=true、写盘、返回 true。
     * 当天已使用：不改数据，返回 false。
     */
    recordStreakShieldUse(): boolean {
        this.load();
        this._ensureStreakShieldDate();
        if (this._data.streakShieldUsedToday) {
            return false;
        }
        this._data.streakShieldDate = this._getTodayStr();
        this._data.streakShieldUsedToday = true;
        this._flush();
        console.log(`[SaveManager] recordStreakShieldUse → date=${this._data.streakShieldDate}`);
        return true;
    }

    /** 判断某章节宝箱是否已领取（chapter 非法返回 false） */
    hasClaimedChapterChest(chapter: number): boolean {
        this.load();
        if (typeof chapter !== 'number' || !Number.isFinite(chapter) || !Number.isSafeInteger(chapter) || chapter < 1) return false;
        return this._data.chapterChestClaims[chapter] === true;
    }

    /**
     * 标记某章节宝箱已领取（幂等）。
     * chapter 合法且未领取：标记 true、写盘、返回 true。
     * 已领取或 chapter 非法：不改数据、返回 false。
     * 本方法不发币，Y3.2 由 GameManager 根据返回值发奖励。
     */
    claimChapterChest(chapter: number): boolean {
        this.load();
        if (typeof chapter !== 'number' || !Number.isFinite(chapter) || !Number.isSafeInteger(chapter) || chapter < 1) return false;
        if (this._data.chapterChestClaims[chapter] === true) {
            return false;
        }
        this._data.chapterChestClaims[chapter] = true;
        this._flush();
        console.log(`[SaveManager] claimChapterChest(chapter=${chapter}) → true`);
        return true;
    }

    // ── 内部 ────────────────────────────────────

    private _flush(): void {
        try {
            const str = JSON.stringify(this._data);
            this._writeRaw(str);
        } catch (e) {
            console.warn('[SaveManager] 写盘失败:', e);
        }
    }
}
