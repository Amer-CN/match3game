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
}

// ── 常量 ────────────────────────────────────

const SAVE_KEY = 'mxmh_save_v1';

function createDefaultSave(): SaveData {
    return {
        maxUnlockedLevel: 1,
        levelRecords: {},
        gachaCoins: 0,
        collection: {},
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

        return result;
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
