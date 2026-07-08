import {
    _decorator,
    Component,
    Node,
    Sprite,
    UITransform,
    Color,
    builtinResMgr,
    SpriteFrame,
    Graphics,
    Label,
    resources,
    tween,
    Tween,
    Vec3,
    Vec2,
    EventTouch,
    UIOpacity,
} from 'cc';
import { AudioManager } from './AudioManager';
import { VibrateManager } from './VibrateManager';
import { TileGesture } from './TileGesture';

const { ccclass } = _decorator;

/** 方块节点 → (row, col) 的反查信息 */
interface TileInfo {
    row: number;
    col: number;
}

/** 特效方块类型 */
export enum SpecialType {
    NONE = 0,
    LINE_H = 1,   // 横向消除条（消一整行）
    LINE_V = 2,   // 竖向消除条（消一整列）
    BOMB = 3,     // 3×3 炸弹
    COLOR_BOMB = 4, // 彩球（消同色全盘）
}

/** 匹配组的形状类型 */
enum MatchShape {
    NORMAL = 0,   // 普通 3 连
    LINE_H_4 = 1, // 横向 4 连
    LINE_V_4 = 2, // 纵向 4 连
    LT = 3,       // L 或 T 形
    LINE_5 = 4,   // 直线 ≥5
}

/** 一组匹配（连续同色） */
interface MatchGroup {
    cells: Array<{ row: number; col: number }>;
    colorId: number;
    shape: MatchShape;
}

/** 棋盘状态机 */
export enum BoardState {
    /** 空闲：接受玩家输入 */
    IDLE = 0,
    /** 交换动画进行中（含无效回弹） */
    SWAPPING = 1,
    /** 连锁消除循环进行中 */
    CHAINING = 2,
    /** 外部锁定（结算/步数弹层等） */
    LOCKED = 3,
}

/** Board → GameManager 回调接口 */
export interface BoardCallbacks {
    /** 有效交换（触发了消除）→ GameManager 扣 1 步 */
    onValidSwap?: () => void;
    /** 分数变化 → GameManager 更新 HUD */
    onScoreChange?: (score: number) => void;
    /** 整轮连锁结算完成 → GameManager 判定胜负 */
    onChainComplete?: () => void;
    /** 元素被消除 → GameManager 收集计数（colorId = 0..5） */
    onTileEliminated?: (colorId: number) => void;
    /** 特效块被引爆 → GameManager 特效计数（每次 +1） */
    onSpecialDetonated?: () => void;
}

@ccclass('Board')
export class Board extends Component {
    // ── 棋盘常量 ──────────────────────────────
    static readonly ROWS = 8;
    static readonly COLS = 8;
    static readonly TILE_SIZE = 70;
    static readonly GAP = 6;
    static readonly SWAP_DURATION = 0.15;          // C1: 交换时长
    static readonly SELECT_SCALE = 1.08;
    static readonly ELIMINATE_SCALE_UP = 0.04;      // C1: 消除放大时长（总 0.12s）
    static readonly ELIMINATE_SCALE_DOWN = 0.08;    // C1: 消除缩小时长
    static readonly FALL_BASE_DURATION = 0.15;      // C1: 下落基础时长（×√格数）
    static readonly COLUMN_DELAY = 0.03;            // C1: 列间瀑布延迟
    static readonly SWIPE_THRESHOLD = 20; // 滑动识别阈值（UI 坐标 px）
    static readonly IDLE_HINT_DELAY = 5;   // A4: 空闲提示触发秒数
    static readonly GUIDE_HINT_DELAY = 3;   // C0: L1 手势引导触发秒数
    static readonly HINT_SCALE = 1.15;     // 提示高亮缩放
    static readonly MAX_STATE_TIME = 15;   // C3: 非IDLE态最大停留秒数（防卡死）

    // 6 色底色（L1/L2 用前 5 种，L3 用全部 6 种）— 明度阶梯：黄最亮→紫最暗
    static readonly COLORS: Color[] = [
        new Color(0xFF, 0x8F, 0xB3),  // 0: 粉·兔 #FF8FB3
        new Color(0x6F, 0xB7, 0xF5),  // 1: 蓝·熊 #6FB7F5
        new Color(0x7F, 0xD9, 0x8A),  // 2: 绿·象 #7FD98A
        new Color(0xFF, 0xD8, 0x4D),  // 3: 黄·鹿 #FFD84D（最亮）
        new Color(0xB5, 0x83, 0xE0),  // 4: 紫·龙 #B583E0（最暗）
        new Color(0xFF, 0x9E, 0x4D),  // 5: 橙·狐 #FF9E4D
    ];

    // 立体层叠：顶部提亮色
    static readonly TILE_TOP_LIGHT: Color[] = [
        new Color(0xFF, 0xB3, 0xCC),  // 0: 粉
        new Color(0xA0, 0xD2, 0xFA),  // 1: 蓝
        new Color(0xA8, 0xE8, 0xB0),  // 2: 绿
        new Color(0xFF, 0xE6, 0x8A),  // 3: 黄
        new Color(0xCD, 0xA6, 0xEC),  // 4: 紫
        new Color(0xFF, 0xB9, 0x80),  // 5: 橙
    ];

    // 立体层叠：底部暗色
    static readonly TILE_BOTTOM_DARK: Color[] = [
        new Color(0xF5, 0x6E, 0x99),  // 0: 粉
        new Color(0x4A, 0x9E, 0xEB),  // 1: 蓝
        new Color(0x5F, 0xC4, 0x6E),  // 2: 绿
        new Color(0xF5, 0xC2, 0x1F),  // 3: 黄
        new Color(0x9E, 0x63, 0xD1),  // 4: 紫
        new Color(0xF5, 0x85, 0x2B),  // 5: 橙
    ];

    // 立体层叠：描边色（比自身深一档，禁止白色描边）
    static readonly TILE_STROKE: Color[] = [
        new Color(0xDB, 0x54, 0x80),  // 0: 粉
        new Color(0x2F, 0x86, 0xD6),  // 1: 蓝
        new Color(0x46, 0xA8, 0x55),  // 2: 绿
        new Color(0xE0, 0xA8, 0x00),  // 3: 黄
        new Color(0x83, 0x48, 0xB8),  // 4: 紫
        new Color(0xDB, 0x6E, 0x1A),  // 5: 橙
    ];

    // 6 种萌宠 emoji，与类型索引一一对应（顺序固定）
    static readonly EMOJIS: string[] = [
        '🐰',  // 0 → 粉·兔
        '🐻',  // 1 → 蓝·熊
        '🐘',  // 2 → 绿·象
        '🦌',  // 3 → 黄·鹿
        '🐉',  // 4 → 紫·龙
        '🦊',  // 5 → 橙·狐
    ];

    // ── 数据模型 ──────────────────────────────
    private grid: number[][] = [];
    private tiles: Node[][] = [];
    private tileSpecials: SpecialType[][] = [];  // B0: 每格的特效类型
    private tileInfoMap: Map<Node, TileInfo> = new Map();
    private whiteFrame: SpriteFrame | null = null;
    /** 特效贴图 SpriteFrame 缓存 */
    private fxLineFrame: SpriteFrame | null = null;
    private fxBombFrame: SpriteFrame | null = null;
    private fxColorBombFrame: SpriteFrame | null = null;

    /** B0: 玩家本次交换的两个格子（用于特效落点优先） */
    private _lastSwapCells: Array<{ row: number; col: number }> = [];

    /** B3 修复: 本轮已激活的特效格 key 集合（防主动+被动双重触发） */
    private _activatedSpecials: Set<string> = new Set();

    /** 怪物头像 SpriteFrame 数组，index 0..5 对应 6 种类型 */
    private monsterFrames: (SpriteFrame | null)[] = [null, null, null, null, null, null];
    /** 头像资源是否加载完毕 */
    private framesReady = false;
    /** 加载期间暂存的 resetBoard 参数 */
    private pendingColorCount: number | null = null;

    /** 当前关卡使用的颜色种类数 */
    private colorCount: number = 5;

    // ── 交互状态 ──────────────────────────────
    private selectedTile: Node | null = null;
    private _state: BoardState = BoardState.IDLE;

    // ── A4 空闲提示状态 ──────────────────────
    private _idleTimer: number = 0;
    private _hintNodes: Node[] | null = null;  // 正在播放提示动画的两个方块

    // ── C0 L1 手势引导状态 ──────────────────
    private _currentLevel: number = 0;       // 当前关卡索引（0=L1）
    private _guideNode: Node | null = null;  // 手指引导节点
    private _guideHintNodes: Node[] | null = null;  // 引导高亮的方块

    // ── C2 特效层（COMBO/引导/洗牌提示统一挂这层，确保在方块之上） ──
    private _effectsLayer: Node | null = null;

    // ── C3 状态超时计时 ──────────────────────
    private _stateTimer: number = 0;

    /** 当前棋盘状态（只读，供外部查询） */
    public get state(): BoardState { return this._state; }

    /** 切换状态并打印日志 */
    private setState(s: BoardState): void {
        if (this._state === s) return;
        console.log(`[Board] 状态切换: ${BoardState[this._state]} → ${BoardState[s]}`);
        this._state = s;
        this._stateTimer = 0;  // C3: 每次状态切换重置超时计时
    }

    /** 是否接受玩家输入（仅 IDLE 态接受） */
    private get inputEnabled(): boolean { return this._state === BoardState.IDLE; }

    // ── 计分 ──────────────────────────────────
    private totalScore = 0;

    // ── 回调 ──────────────────────────────────
    private callbacks: BoardCallbacks = {};

    // ══════════════════════════════════════════════════════════════════════════
    //  生命周期
    // ══════════════════════════════════════════════════════════════════════════

    onLoad(): void {
        console.log('=== BOARD LOADED 新代码已生效 ===');
        this.whiteFrame = builtinResMgr.get<SpriteFrame>('default-sprite-splash');
        // AudioManager 已在场景中作为独立节点存在，无需此处再加
        // 确保 VibrateManager 存在（单例，预览环境无 wx/tt 自动 no-op）
        if (!VibrateManager.inst) {
            this.node.addComponent(VibrateManager);
        }
        this.loadMonsterFrames();
        this.loadSpecialFrames();  // 加载特效贴图
        // 触摸由 TileGesture 组件处理，无需棋盘层监听

        // ── 调试入口（A2 验证用，测完删除）──
        if (typeof window !== 'undefined') {
            const win = window as any;
            win.__boardDebug__ = {
                testShuffle: () => {
                    console.log('[DEBUG] ★ 触发洗牌动画');
                    this.shuffleBoardWithHint();
                },
                testDeadlock: () => {
                    console.log('[DEBUG] ★ 强制死局（临时禁用 hasAnyValidMove 返回 true）');
                    win.__debugForceDeadlock__ = true;
                    setTimeout(() => { win.__debugForceDeadlock__ = false; }, 5000);
                },
                testForceRegen: async () => {
                    console.log('[DEBUG] ★ 强制触发 forceRegenerateBoard（洗牌上限临时改为 1）');
                    win.__debugForceRegenLimit__ = true;
                    win.__debugForceDeadlock__ = true;  // 确保洗牌必失败
                    // 触发洗牌（内部会因上限 1 + 死局标志而走到 forceRegenerateBoard）
                    await this.shuffleBoardWithHint();
                    // ★ 洗牌完成后：清除所有调试标志，打印真实可解性
                    win.__debugForceRegenLimit__ = false;
                    win.__debugForceDeadlock__ = false;
                    const realResult = this.hasAnyValidMove();
                    console.log('[DEBUG] ★ forceRegenerateBoard 后真实 hasAnyValidMove =', realResult);
                    if (!realResult) {
                        console.error('[DEBUG] ⚠ 重生成后仍无可行步！请检查 forceRegenerateBoard 逻辑');
                    } else {
                        console.log('[DEBUG] ✓ 重生成后棋盘有可行步，验证通过');
                    }
                },
            };
            console.log('[DEBUG] 调试入口已挂载，用 window.__boardDebug__.testShuffle() / .testDeadlock() / .testForceRegen()');
        }

        // ===== TEMP DEBUG (B3/B4 补测·上线前删) =====
        {
            const g = globalThis as any;
            const SPECIAL_MAP: Record<string, number> = {
                'NONE': SpecialType.NONE,
                'LINE_H': SpecialType.LINE_H,
                'LINE_V': SpecialType.LINE_V,
                'BOMB': SpecialType.BOMB,
                'COLOR_BOMB': SpecialType.COLOR_BOMB,
            };

            /** 把 (r,c) 的特效设为指定类型 + 刷角标视觉；越界忽略 */
            const setSpecial = (r: number, c: number, typeName: string): void => {
                if (r < 0 || r >= Board.ROWS || c < 0 || c >= Board.COLS) return;
                const st = SPECIAL_MAP[typeName];
                if (st === undefined) { console.warn('[boardDebug] 未知类型:', typeName); return; }
                this.tileSpecials[r][c] = st;
                // NONE 时手动清角标（applySpecialVisual 对 NONE 会 return）
                const tileNode = this.tiles[r]?.[c];
                if (!tileNode) return;
if (st === SpecialType.NONE) {
this.removeSpecialVisual(tileNode);
console.log(`[boardDebug] setSpecial(${r},${c}) = NONE (角标已清)`);
                } else {
                    this.applySpecialVisual(r, c, st);
                    console.log(`[boardDebug] setSpecial(${r},${c}) = ${typeName} ✓`);
                }
            };

            g.boardDebug = {
                /** 单格设特效 */
                setSpecial: (r: number, c: number, typeName: string) => setSpecial(r, c, typeName),

                /** 彩球 */
                colorBomb: (r: number, c: number) => setSpecial(r, c, 'COLOR_BOMB'),

                /** 线+线（B4 大十字）：(r,c)=LINE_H, (r,c+1)=LINE_V */
                pairLineLine: (r: number, c: number) => {
                    let c2 = c + 1;
                    if (c2 >= Board.COLS) { r += 1; c2 = c; }  // 越界则换到下一行同列
                    if (r >= Board.ROWS) return;
                    setSpecial(r, c, 'LINE_H');
                    setSpecial(r, c2, 'LINE_V');
                    console.log(`[boardDebug] pairLineLine: (${r},${c})=LINE_H + (${r},${c2})=LINE_V → 滑动交换验证大十字`);
                },

                /** 彩球+线（B4）：(r,c)=COLOR_BOMB, (r,c+1)=LINE_H */
                pairColorBombLine: (r: number, c: number) => {
                    let c2 = c + 1;
                    if (c2 >= Board.COLS) { r += 1; c2 = c; }
                    if (r >= Board.ROWS) return;
                    setSpecial(r, c, 'COLOR_BOMB');
                    setSpecial(r, c2, 'LINE_H');
                    console.log(`[boardDebug] pairColorBombLine: (${r},${c})=COLOR_BOMB + (${r},${c2})=LINE_H → 滑动交换验证`);
                },

                /** 彩球+彩球（B4 清屏）：(r,c) 与 (r,c+1) 都设 COLOR_BOMB */
                pairColorBomb: (r: number, c: number) => {
                    let c2 = c + 1;
                    if (c2 >= Board.COLS) { r += 1; c2 = c; }
                    if (r >= Board.ROWS) return;
                    setSpecial(r, c, 'COLOR_BOMB');
                    setSpecial(r, c2, 'COLOR_BOMB');
                    console.log(`[boardDebug] pairColorBomb: (${r},${c}) + (${r},${c2}) 双彩球 → 滑动交换验证清屏`);
                },

                /** 打印整盘 tileSpecials 矩阵 */
                dump: () => {
                    const names: Record<number, string> = {
                        0: '·', 1: 'H', 2: 'V', 3: 'B', 4: 'C',
                    };
                    console.log('[boardDebug] === tileSpecials 矩阵 ===');
                    for (let r = 0; r < Board.ROWS; r++) {
                        const row = this.tileSpecials[r]?.map((s: number) => names[s] ?? '?').join(' ') ?? '???';
                        console.log(`  R${r}: ${row}`);
                    }
                },

                /** 确认棋盘可操作 */
                status: () => {
                    console.log(`[boardDebug] _state=${BoardState[this._state]}, inputEnabled=${this.inputEnabled}`);
                },
            };

            console.log('[boardDebug] ★ B3/B4 补测入口已挂载: boardDebug.setSpecial / .colorBomb / .pairLineLine / .pairColorBombLine / .pairColorBomb / .dump / .status');
        }
        // ===== END TEMP DEBUG (B3/B4 补测·上线前删) =====
    }

    onDestroy(): void {
    }

    /** 从 resources/monsters 逐张加载 SpriteFrame（/spriteFrame 子资源路径 + SpriteFrame 类型） */
    private loadMonsterFrames(): void {
        // colorId → 真实文件名映射（统一 mon_ 前缀，与 COLOR_KEY_MAP 一致）
        const entries: Array<{ colorId: number; key: string; fileName: string }> = [
            { colorId: 0, key: 'pink',     fileName: 'mon_pink' },
            { colorId: 1, key: 'blue',     fileName: 'mon_blue' },
            { colorId: 2, key: 'green',    fileName: 'mon_green' },
            { colorId: 3, key: 'yellow',   fileName: 'mon_yellow' },
            { colorId: 4, key: 'purple',   fileName: 'mon_purple' },
            { colorId: 5, key: 'orange',   fileName: 'mon_orange' },
        ];

        let loadedCount = 0;
        const total = entries.length;

        for (const e of entries) {
            const path = `monsters/${e.fileName}/spriteFrame`;
            resources.load(path, SpriteFrame, (err, frame) => {
                if (err || !frame) {
                    console.warn(`[Board] 怪物贴图加载失败 [${e.key}] -> ${path}，使用 emoji 降级:`, err);
                } else {
                    this.monsterFrames[e.colorId] = frame;
                    console.log(`[Board] 怪物贴图加载成功 [${e.key}] -> ${path}`);
                }

                loadedCount++;
                if (loadedCount >= total) {
                    // 全部加载完毕（无论成功或失败）→ 生成棋盘
                    if (!this.framesReady) {
                        this.framesReady = true;
                        this.generateBoard();
                        this.flushPending();
                    }
                }
            });
        }
    }

    /** 从 resources/specials 逐张加载 SpriteFrame（/spriteFrame 子资源路径 + SpriteFrame 类型） */
    private loadSpecialFrames(): void {
        const loadOne = (key: string, path: string, field: 'line' | 'bomb' | 'colorBomb') => {
            resources.load(path, SpriteFrame, (err, frame) => {
                if (err || !frame) {
                    console.warn(`[Board] 特效贴图加载失败 [${key}] -> ${path}，使用 Graphics fallback:`, err);
                    return;
                }
                if (field === 'line') this.fxLineFrame = frame;
                else if (field === 'bomb') this.fxBombFrame = frame;
                else if (field === 'colorBomb') this.fxColorBombFrame = frame;
                console.log(`[Board] 特效贴图加载成功 [${key}] -> ${path}`);
            });
        };
        loadOne('line',      'specials/fx_line/spriteFrame',       'line');
        loadOne('bomb',      'specials/fx_bomb/spriteFrame',       'bomb');
        loadOne('colorBomb', 'specials/fx_colorbomb/spriteFrame',  'colorBomb');
    }

    /** 获取特效贴图（按类型） */
    private getSpecialFrame(special: SpecialType): SpriteFrame | null {
        switch (special) {
            case SpecialType.LINE_H:
            case SpecialType.LINE_V:
                return this.fxLineFrame;
            case SpecialType.BOMB:
                return this.fxBombFrame;
            case SpecialType.COLOR_BOMB:
                return this.fxColorBombFrame;
            default:
                return null;
        }
    }

    /** 处理加载期间暂存的 resetBoard 请求 */
    private flushPending(): void {
        if (this.pendingColorCount !== null) {
            const cc = this.pendingColorCount;
            this.pendingColorCount = null;
            this.resetBoard(cc);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  公开接口 — 供 GameManager 调用
    // ══════════════════════════════════════════════════════════════════════════

    /** 设置回调 */
    public setCallbacks(callbacks: BoardCallbacks): void {
        this.callbacks = callbacks;
    }

    /** 重置棋盘：销毁所有方块，用新的颜色种类数重新生成 */
    public resetBoard(colorCount: number): void {
        // 头像未加载完时暂存请求
        if (!this.framesReady) {
            this.pendingColorCount = colorCount;
            return;
        }

        // 停止所有 tween
        for (let r = 0; r < Board.ROWS; r++) {
            for (let c = 0; c < Board.COLS; c++) {
                const node = this.tiles[r]?.[c];
                if (node) {
                    Tween.stopAllByTarget(node);
                    node.destroy();
                }
            }
        }

        this.grid = [];
        this.tiles = [];
        this.tileSpecials = [];
        this.tileInfoMap.clear();
        this.selectedTile = null;
        this._activatedSpecials.clear();  // B3 修复: 重置已激活集合
        this.stopGuideAnimation();   // C0: 停止引导
        this.stopHintAnimation();    // 停止提示
        if (this._effectsLayer && this._effectsLayer.isValid) {
            this._effectsLayer.removeAllChildren();
        }
        this.setState(BoardState.IDLE);
        this.totalScore = 0;
        this.colorCount = Math.min(colorCount, Board.COLORS.length);

        this.generateBoard();
    }

    /** 外部锁定/解锁棋盘（弹层时用） */
    public setBusy(busy: boolean): void {
        this.setState(busy ? BoardState.LOCKED : BoardState.IDLE);
    }

    /** 分数翻倍（看广告占位） */
    public multiplyScore(multiplier: number): void {
        this.totalScore = Math.round(this.totalScore * multiplier);
        this.callbacks.onScoreChange?.(this.totalScore);
    }

    public getScore(): number {
        return this.totalScore;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  棋盘生成（保证开局无三连）
    // ══════════════════════════════════════════════════════════════════════════

    private generateBoard(): void {
        const { ROWS, COLS, TILE_SIZE, GAP } = Board;
        const totalWidth = COLS * TILE_SIZE + (COLS - 1) * GAP;
        const totalHeight = ROWS * TILE_SIZE + (ROWS - 1) * GAP;
        const uiTransform = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        uiTransform.setContentSize(totalWidth, totalHeight);

        // ── 棋盘底板 + 格子凹槽（仅创建一次，resetBoard 不重建） ──
        if (!this.node.getChildByName('BoardPanel')) {
            this.createBoardPanel(totalWidth, totalHeight);
            this.createCellSlots();
        }

        for (let r = 0; r < ROWS; r++) {
            this.grid[r] = [];
            this.tiles[r] = [];
            this.tileSpecials[r] = [];
            for (let c = 0; c < COLS; c++) {
                const colorId = this.pickSafeColor(r, c);
                const tileNode = this.createTileNode(r, c, colorId);
                this.grid[r][c] = colorId;
                this.tiles[r][c] = tileNode;
                this.tileSpecials[r][c] = SpecialType.NONE;
                this.tileInfoMap.set(tileNode, { row: r, col: c });
            }
        }

        // ★ A3: 开局/切关保证 — 无现成三连 && 有可行步（静默，无提示文字）
        this.ensureValidBoard();

        // C2: 创建特效层（确保在方块之上）
        this.ensureEffectsLayer();

        // 临时验证日志（测完删除）
        const matchCount = this.findMatches().length;
        const hasMove = this.findAnyValidMove() !== null;
        console.log(`[Board] 开局校验: findMatches=${matchCount}, hasAnyValidMove=${hasMove}`);
    }

    /** 随机选一个不会与左侧 / 上方已放置方块形成三连的颜色 */
    private pickSafeColor(row: number, col: number): number {
        const forbidden = new Set<number>();

        if (col >= 2 && this.grid[row][col - 1] === this.grid[row][col - 2]) {
            forbidden.add(this.grid[row][col - 1]);
        }
        if (row >= 2 && this.grid[row - 1][col] === this.grid[row - 2][col]) {
            forbidden.add(this.grid[row - 1][col]);
        }

        const candidates: number[] = [];
        for (let i = 0; i < this.colorCount; i++) {
            if (!forbidden.has(i)) candidates.push(i);
        }
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // ── 棋盘底板（奶油藕荷中调托盘 + 凹陷感内阴影） ──
    private createBoardPanel(gridW: number, gridH: number): void {
        const padding = 24;
        const panelW = gridW + padding * 2;
        const panelH = gridH + padding * 2;
        const radius = 32;

        const panelNode = new Node('BoardPanel');
        panelNode.parent = this.node;
        panelNode.setSiblingIndex(0); // 最底层

        const panelUT = panelNode.addComponent(UITransform);
        panelUT.setContentSize(panelW, panelH);
        panelNode.setPosition(0, 0, 0);

        const g = panelNode.addComponent(Graphics);

        // 轻投影（向下偏移 4px 的半透明深色圆角矩形）
        g.fillColor = new Color(0, 0, 0, 25);
        g.roundRect(-panelW / 2 + 2, -panelH / 2 - 4, panelW, panelH, radius);
        g.fill();

        // 底板主体：奶油藕荷 #EFE3EC + 2px #D9C2DA 描边
        g.fillColor = new Color(0xEF, 0xE3, 0xEC);
        g.strokeColor = new Color(0xD9, 0xC2, 0xDA);
        g.lineWidth = 2;
        g.roundRect(-panelW / 2, -panelH / 2, panelW, panelH, radius);
        g.fill();
        g.stroke();

        // 四边向内 3px 内阴影 — 糖果盘下凹感
        g.fillColor = new Color(0, 0, 0, 25);
        // 顶部内阴影
        g.roundRect(-panelW / 2 + 2, panelH / 2 - 5, panelW - 4, 3, 2);
        g.fill();
        // 底部内阴影
        g.roundRect(-panelW / 2 + 2, -panelH / 2 + 2, panelW - 4, 3, 2);
        g.fill();
        // 左侧内阴影
        g.roundRect(-panelW / 2 + 2, -panelH / 2 + 2, 3, panelH - 4, 2);
        g.fill();
        // 右侧内阴影
        g.roundRect(panelW / 2 - 5, -panelH / 2 + 2, 3, panelH - 4, 2);
        g.fill();
    }

    // ── 格子凹槽（比底板深一档 #E2D3E4，圆角 14，方块坐进凹槽里） ──
    private createCellSlots(): void {
        const { ROWS, COLS, TILE_SIZE } = Board;
        const slotNode = new Node('CellSlots');
        slotNode.parent = this.node;
        slotNode.setSiblingIndex(1); // 在底板之上、tile 之下

        const slotUT = slotNode.addComponent(UITransform);
        slotUT.setContentSize(this.node.getComponent(UITransform)!.width, this.node.getComponent(UITransform)!.height);

        const g = slotNode.addComponent(Graphics);
        // 比底板深一档的凹槽色 #E2D3E4
        g.fillColor = new Color(0xE2, 0xD3, 0xE4);

        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const pos = this.tileToLocalPosition(r, c);
                g.roundRect(pos.x - TILE_SIZE / 2, pos.y - TILE_SIZE / 2, TILE_SIZE, TILE_SIZE, 14);
                g.fill();
            }
        }
    }

    private createTileNode(row: number, col: number, colorId: number): Node {
        const { TILE_SIZE, EMOJIS } = Board;
        const tileNode = new Node(`Tile_${row}_${col}`);
        tileNode.parent = this.node;

        const tileUT = tileNode.addComponent(UITransform);
        tileUT.setContentSize(TILE_SIZE, TILE_SIZE);

        const pos = this.tileToLocalPosition(row, col);
        tileNode.setPosition(pos);

        // ── 4 层糖果立体方块（从下到上叠出立体感） ──
        const base = Board.COLORS[colorId];
        const topLight = Board.TILE_TOP_LIGHT[colorId];
        const bottomDark = Board.TILE_BOTTOM_DARK[colorId];
        const stroke = Board.TILE_STROKE[colorId];
        const g = tileNode.addComponent(Graphics);
        const radius = 14;
        const half = TILE_SIZE / 2;

        // 1. 接触投影层：略大圆角矩形 Color(80,55,85,70)，偏移 (0,-4) — 浮起感
        g.fillColor = new Color(80, 55, 85, 70);
        g.roundRect(-half + 1, -half - 4, TILE_SIZE, TILE_SIZE, radius);
        g.fill();

        // 2. 底色层：base 色圆角矩形，圆角 14
        g.fillColor = base.clone();
        g.roundRect(-half, -half, TILE_SIZE, TILE_SIZE, radius);
        g.fill();

        // 3a. 底部内阴影：下半部叠 bottomDark 带（alpha 120）— 受光变暗
        g.fillColor = new Color(bottomDark.r, bottomDark.g, bottomDark.b, 120);
        g.roundRect(-half, -half, TILE_SIZE, TILE_SIZE * 0.45, radius);
        g.fill();

        // 3b. 顶部提亮：上半部叠 topLight 带（alpha 140）— 上端受光
        g.fillColor = new Color(topLight.r, topLight.g, topLight.b, 140);
        g.roundRect(-half, 0, TILE_SIZE, half, radius);
        g.fill();

        // 3c. 高光点：顶部偏上白色椭圆，宽约 55%，Color(255,255,255,90) — 糖果反光
        g.fillColor = new Color(255, 255, 255, 90);
        g.ellipse(0, half * 0.4, TILE_SIZE * 0.275, TILE_SIZE * 0.06);
        g.fill();

        // 4. 描边：1.5px stroke 色（比自身深一档，禁止白色描边）
        g.strokeColor = stroke.clone();
        g.lineWidth = 1.5;
        g.roundRect(-half, -half, TILE_SIZE, TILE_SIZE, radius);
        g.stroke();

        // ── 怪物头 Sprite（加载成功时）/ emoji Label（降级） ──
        const frame = this.monsterFrames[colorId];
        if (frame) {
            const monsterNode = new Node('Monster');
            monsterNode.parent = tileNode;
            monsterNode.setPosition(0, 0, 0);       // 对齐格子中心

            const monsterUT = monsterNode.addComponent(UITransform);
            monsterUT.setAnchorPoint(0.5, 0.5);     // 锚点居中（必须在 UITransform 上设）
            // ★ scale 硬缩方案：不受 sizeMode / trim 影响，最稳
            // 1. UITransform 先归到原生 256×256
            monsterUT.setContentSize(256, 256);

            const monsterSprite = monsterNode.addComponent(Sprite);
            monsterSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            monsterSprite.trim = false;
            monsterSprite.spriteFrame = frame;

            // 2. 赋 spriteFrame 后再次确保 contentSize = 256（防止被覆盖）
            monsterUT.setContentSize(256, 256);

            // 3. 用 scale 把 256px 硬缩到格子大小（留 10% 缝隙）
            //    TILE_SIZE=70, target=63, scale=63/256≈0.2461
            const target = TILE_SIZE * 0.9;
            const s = target / 256;
            monsterNode.setScale(s, s, 1);
        } else {
            // 降级：emoji Label
            const emojiNode = new Node('Emoji');
            emojiNode.parent = tileNode;
            const emojiUT = emojiNode.addComponent(UITransform);
            emojiUT.setContentSize(TILE_SIZE, TILE_SIZE);
            const emojiLabel = emojiNode.addComponent(Label);
            emojiLabel.string = EMOJIS[colorId] ?? '?';
            emojiLabel.fontSize = Math.round(TILE_SIZE * 0.6);
            emojiLabel.lineHeight = Math.round(TILE_SIZE * 0.6);
            emojiLabel.useSystemFont = true;
            emojiLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
            emojiLabel.verticalAlign = Label.VerticalAlign.CENTER;
            emojiLabel.overflow = Label.Overflow.NONE;
        }

        // 挂载 TileGesture 组件（处理点击+滑动）
        const gesture = tileNode.addComponent(TileGesture);
        gesture.row = row;
        gesture.col = col;
        return tileNode;
    }

    private tileToLocalPosition(row: number, col: number): Vec3 {
        const { ROWS, COLS, TILE_SIZE, GAP } = Board;
        const totalWidth = COLS * TILE_SIZE + (COLS - 1) * GAP;
        const totalHeight = ROWS * TILE_SIZE + (ROWS - 1) * GAP;
        const startX = -totalWidth / 2 + TILE_SIZE / 2;
        const startY = totalHeight / 2 - TILE_SIZE / 2;
        return new Vec3(
            startX + col * (TILE_SIZE + GAP),
            startY - row * (TILE_SIZE + GAP),
            0,
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  触摸交互
    // ══════════════════════════════════════════════════════════════════════════

    private inBounds(r: number, c: number): boolean {
        return r >= 0 && r < Board.ROWS && c >= 0 && c < Board.COLS
            && !!this.tiles[r] && !!this.tiles[r][c];
    }

    // ── 点击逻辑（供 TileGesture 调用） ──────────────
    public onCellClick(row: number, col: number): void {
        if (!this.inputEnabled) {
            console.log(`[Board] 输入忽略: onCellClick(${row},${col}) state=${BoardState[this._state]}`);
            return;
        }
        this.markPlayerActive();
        const tileNode = this.tiles[row]?.[col];
        if (!tileNode) return;
        const info = { row, col };

        if (this.selectedTile === null) {
            this.selectTile(tileNode);
        } else if (this.selectedTile === tileNode) {
            this.deselectTile();
        } else {
            const selectedInfo = this.tileInfoMap.get(this.selectedTile)!;
            if (this.isAdjacent(selectedInfo, info)) {
                this.swapWithCheck(selectedInfo, info);
            } else {
                this.deselectTile();
                this.selectTile(tileNode);
            }
        }
    }

    // ── 滑动交换入口（供 TileGesture 调用） ────
    public trySwapByDir(r: number, c: number, dr: number, dc: number): void {
        if (this._state !== BoardState.IDLE) {
            console.log(`[Board] 输入忽略: trySwapByDir(${r},${c},${dr},${dc}) state=${BoardState[this._state]}`);
            return;
        }
        this.markPlayerActive();
        const nr = r + dr;
        const nc = c + dc;
        if (!this.inBounds(nr, nc)) {
            console.log('SWIPE_OUT_OF_BOUNDS');
            return;
        }
        // 取消选中态
        this.deselectTile();

        console.log('SWIPE_SWAP_CALL', { r, c }, { r: nr, c: nc });
        this.swapWithCheck(
            { row: r, col: c },
            { row: nr, col: nc },
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  A4 · 空闲提示 hint
    // ══════════════════════════════════════════════════════════════════════════

    /** 玩家操作时调用：重置空闲计时 + 停止正在播放的提示动画 */
    private markPlayerActive(): void {
        this._idleTimer = 0;
        if (this._hintNodes) {
            this.stopHintAnimation();
        }
        if (this._guideNode) {
            this.stopGuideAnimation();
        }
    }

    update(dt: number): void {
        // C3: 非IDLE态超时保护（防卡死）
        if (this._state !== BoardState.IDLE) {
            this._stateTimer += dt;
            if (this._stateTimer > Board.MAX_STATE_TIME) {
                console.error(`[Board] ⚠ 状态超时(${Board.MAX_STATE_TIME}s)，强制回 IDLE`);
                this.setState(BoardState.IDLE);
            }
            if (this._hintNodes) this.stopHintAnimation();
            if (this._guideNode) this.stopGuideAnimation();
            this._idleTimer = 0;
            return;
        }

        // 已经在播提示或引导了，不重复触发
        if (this._hintNodes || this._guideNode) return;

        this._idleTimer += dt;

        if (this._currentLevel === 0) {
            // C0: L1 — 3s 空闲触发手势引导
            if (this._idleTimer >= Board.GUIDE_HINT_DELAY) {
                this._idleTimer = 0;
                this.startGuideAnimation();
            }
        } else {
            // A4: L2+ — 5s 空闲触发提示
            if (this._idleTimer >= Board.IDLE_HINT_DELAY) {
                this._idleTimer = 0;
                this.startHintAnimation();
            }
        }
    }

    /** 调 findAnyValidMove 拿到一对坐标，对这两格播循环脉冲动画 */
    private startHintAnimation(): void {
        const move = this.findAnyValidMove();
        if (!move) return; // 拿不到可行步就不提示、不报错

        const nodeA = this.tiles[move.a.r]?.[move.a.c];
        const nodeB = this.tiles[move.b.r]?.[move.b.c];
        if (!nodeA || !nodeB) return;

        this._hintNodes = [nodeA, nodeB];

        const hintScale = Board.HINT_SCALE;
        for (const node of this._hintNodes) {
            Tween.stopAllByTarget(node);
            tween(node)
                .to(0.4, { scale: new Vec3(hintScale, hintScale, 1) }, { easing: 'sineOut' })
                .to(0.4, { scale: new Vec3(1, 1, 1) }, { easing: 'sineIn' })
                .union()
                .repeatForever()
                .start();
        }

        console.log('[Board] 💡 空闲提示触发:', move);
    }

    /** 停止提示动画，复位方块的 scale */
    private stopHintAnimation(): void {
        if (!this._hintNodes) return;

        for (const node of this._hintNodes) {
            if (node && node.isValid) {
                Tween.stopAllByTarget(node);
                node.setScale(1, 1, 1);
            }
        }

        this._hintNodes = null;
        console.log('[Board] 💡 空闲提示已停止');
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  C0 · L1 手势引导
    // ══════════════════════════════════════════════════════════════════════════

    /** C0: 设置当前关卡号（0=L1），供手势引导判断 */
    public setLevel(level: number): void {
        this._currentLevel = level;
        if (level !== 0 && this._guideNode) {
            this.stopGuideAnimation();
        }
        console.log(`[Board] 当前关卡: L${level + 1} (index=${level})`);
    }

    /** C0: L1 手势引导 — 手指从 a 格滑到 b 格，循环播放 + 两格脉冲高亮 */
    private startGuideAnimation(): void {
        const move = this.findAnyValidMove();
        if (!move) return;

        const nodeA = this.tiles[move.a.r]?.[move.a.c];
        const nodeB = this.tiles[move.b.r]?.[move.b.c];
        if (!nodeA || !nodeB) return;

        const posA = this.tileToLocalPosition(move.a.r, move.a.c);
        const posB = this.tileToLocalPosition(move.b.r, move.b.c);

        // C0 护栏：坐标 NaN 保护
        if (!isFinite(posA.x) || !isFinite(posA.y) || !isFinite(posB.x) || !isFinite(posB.y)) {
            console.warn('[Board] 引导坐标异常，跳过引导');
            return;
        }

        // 复用 hint 脉冲高亮两格
        this._guideHintNodes = [nodeA, nodeB];
        const hintScale = Board.HINT_SCALE;
        for (const node of this._guideHintNodes) {
            Tween.stopAllByTarget(node);
            tween(node)
                .to(0.4, { scale: new Vec3(hintScale, hintScale, 1) }, { easing: 'sineOut' })
                .to(0.4, { scale: new Vec3(1, 1, 1) }, { easing: 'sineIn' })
                .union()
                .repeatForever()
                .start();
        }

        // 创建手指引导节点
        const guideNode = new Node('GuideFinger');
        guideNode.parent = this.ensureEffectsLayer();

        const ut = guideNode.addComponent(UITransform);
        ut.setContentSize(Board.TILE_SIZE, Board.TILE_SIZE);

        const label = guideNode.addComponent(Label);
        label.string = '👆';
        label.fontSize = 40;
        label.lineHeight = 44;
        label.color = new Color(255, 255, 255, 220);
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.NONE;

        const opacity = guideNode.addComponent(UIOpacity);
        opacity.opacity = 180;

        guideNode.setPosition(posA);

        // 循环: A→B→停→A→停
        tween(guideNode)
            .to(0.6, { position: new Vec3(posB.x, posB.y, 0) }, { easing: 'sineInOut' })
            .delay(0.2)
            .to(0.6, { position: new Vec3(posA.x, posA.y, 0) }, { easing: 'sineInOut' })
            .delay(0.2)
            .union()
            .repeatForever()
            .start();

        this._guideNode = guideNode;
        console.log('[Board] 👆 L1 手势引导触发:', move);
    }

    /** C0: 停止手势引导 — 销毁手指节点 + 复位高亮方块 */
    private stopGuideAnimation(): void {
        if (this._guideNode) {
            Tween.stopAllByTarget(this._guideNode);
            this._guideNode.destroy();
            this._guideNode = null;
        }
        if (this._guideHintNodes) {
            for (const node of this._guideHintNodes) {
                if (node && node.isValid) {
                    Tween.stopAllByTarget(node);
                    node.setScale(1, 1, 1);
                }
            }
            this._guideHintNodes = null;
        }
        console.log('[Board] 👆 L1 手势引导已停止');
    }

    private selectTile(tileNode: Node): void {
        this.selectedTile = tileNode;
        AudioManager.inst?.playClick();
        tween(tileNode)
            .to(0.1, { scale: new Vec3(Board.SELECT_SCALE, Board.SELECT_SCALE, 1) }, { easing: 'backOut' })
            .start();
    }

    private deselectTile(): void {
        if (!this.selectedTile) return;
        Tween.stopAllByTarget(this.selectedTile);
        this.selectedTile.setScale(1, 1, 1);
        this.selectedTile = null;
    }

    private isAdjacent(a: TileInfo, b: TileInfo): boolean {
        const dr = Math.abs(a.row - b.row);
        const dc = Math.abs(a.col - b.col);
        return (dr === 1 && dc === 0) || (dr === 0 && dc === 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  交换 + 消除判定
    // ══════════════════════════════════════════════════════════════════════════

    private async swapWithCheck(a: TileInfo, b: TileInfo): Promise<void> {
        this.setState(BoardState.SWAPPING);
        let hadMatches = false;
        try {
            // 取消选中态（滑动入口已 deselect，selectedTile 可能为 null）
            if (this.selectedTile) {
                const selected = this.selectedTile;
                this.selectedTile = null;
                Tween.stopAllByTarget(selected);
                selected.setScale(1, 1, 1);
            }

            // 执行交换
            this._lastSwapCells = [{ row: a.row, col: a.col }, { row: b.row, col: b.col }];
            this._activatedSpecials.clear();  // B3 修复: 清空本轮已激活集合
            await this.performSwap(a, b);

            // ★ B3/B4: 主动特效交换检测（在普通匹配判定之前）
            const specialCells = this.triggerSpecialExchange(a, b);

            if (specialCells) {
                // 特效交换被触发 → 展开 + 销毁 + 连锁
                hadMatches = true;
                this.expandSpecialSplash(specialCells);
                await this.destroyCellSet(specialCells);

                this.callbacks.onValidSwap?.();
                this.setState(BoardState.CHAINING);
                await this.processChain();
                this._lastSwapCells = [];
                if (!this.hasAnyValidMove()) {
                    console.log('[Board] ★ 死局检测：无可行步，触发自动洗牌');
                    await this.shuffleBoardWithHint();
                }
            } else {
                // 普通流程：检测匹配
                const matches = this.findMatches();
                if (matches.length === 0) {
                    // 无匹配 → 短暂停顿后换回原位
                    await this.delay(0.15);
                    await this.performSwap(a, b);
                } else {
                    hadMatches = true;
                    this.callbacks.onValidSwap?.();
                    this.setState(BoardState.CHAINING);
                    await this.processChain();
                    // ★ A2: 连锁稳定后检测死局，无解则自动洗牌
                    if (!this.hasAnyValidMove()) {
                        console.log('[Board] ★ 死局检测：无可行步，触发自动洗牌');
                        await this.shuffleBoardWithHint();
                    }
                }
            }
        } catch (e) {
            console.error('[Board] swapWithCheck 异常，强制回 IDLE:', e);
        } finally {
            if (this._state !== BoardState.LOCKED) {
                this.setState(BoardState.IDLE);
            }
        }

        if (hadMatches) {
            this.callbacks.onChainComplete?.();
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  B3/B4 · 主动特效交换
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 交换后检查两格特效，返回初始待消集合（null 表示非特效交换，走普通匹配）。
     * 1. 两个都是特效 → 组合表分派
     * 2. 一个 COLOR_BOMB + 一个普通 → 清该色全盘
     * 3. 其余 → null（走普通匹配）
     */
    private triggerSpecialExchange(a: TileInfo, b: TileInfo): Set<string> | null {
        const { ROWS, COLS } = Board;
        const sa = this.tileSpecials[a.row]?.[a.col] ?? SpecialType.NONE;
        const sb = this.tileSpecials[b.row]?.[b.col] ?? SpecialType.NONE;

        if (sa === SpecialType.NONE && sb === SpecialType.NONE) return null;

        const cells = new Set<string>();
        const addCell = (r: number, c: number) => {
            if (r >= 0 && r < ROWS && c >= 0 && c < COLS) cells.add(`${r},${c}`);
        };
        const isLine = (s: SpecialType) => s === SpecialType.LINE_H || s === SpecialType.LINE_V;
        const isBomb = (s: SpecialType) => s === SpecialType.BOMB;
        const isColor = (s: SpecialType) => s === SpecialType.COLOR_BOMB;

        // ── 两个都是特效 → 组合表 ──
        if (sa !== SpecialType.NONE && sb !== SpecialType.NONE) {
            if (isLine(sa) && isLine(sb)) {
                // 线+线 = 整行+整列（两个交换点）
                for (let cc = 0; cc < COLS; cc++) { addCell(a.row, cc); addCell(b.row, cc); }
                for (let rr = 0; rr < ROWS; rr++) { addCell(rr, a.col); addCell(rr, b.col); }
                console.log(`[B4] 组合激活 类型=线+线 清${cells.size}格`);
            } else if (isBomb(sa) && isBomb(sb)) {
                // 炸弹+炸弹 = 两个交换点各 5×5
                for (let dr = -2; dr <= 2; dr++)
                    for (let dc = -2; dc <= 2; dc++) { addCell(a.row + dr, a.col + dc); addCell(b.row + dr, b.col + dc); }
                console.log(`[B4] 组合激活 类型=炸弹+炸弹 清${cells.size}格`);
            } else if ((isBomb(sa) && isLine(sb)) || (isLine(sa) && isBomb(sb))) {
                // 炸弹+线 = 炸弹位置行±1共3行 + 列±1共3列
                const bp = isBomb(sa) ? a : b;
                for (let cc = 0; cc < COLS; cc++)
                    for (let dr = -1; dr <= 1; dr++) addCell(bp.row + dr, cc);
                for (let rr = 0; rr < ROWS; rr++)
                    for (let dc = -1; dc <= 1; dc++) addCell(rr, bp.col + dc);
                console.log(`[B4] 组合激活 类型=炸弹+线 清${cells.size}格`);
            } else if ((isColor(sa) && (isLine(sb) || isBomb(sb))) || ((isLine(sa) || isBomb(sa)) && isColor(sb))) {
                // 彩球+线/炸弹 = 场上最多色所有格改成该特效类型并全部入队
                const otherSpecial = isColor(sa) ? sb : sa;
                const targetColor = this.getMostCommonColor();
                for (let r = 0; r < ROWS; r++)
                    for (let c = 0; c < COLS; c++)
                        if (this.grid[r] && this.grid[r][c] === targetColor) {
                            this.tileSpecials[r][c] = otherSpecial;
                            addCell(r, c);
                        }
                addCell(a.row, a.col);
                addCell(b.row, b.col);
                console.log(`[B4] 组合激活 类型=彩球+${SpecialType[otherSpecial]} 清${cells.size}格`);
            } else if (isColor(sa) && isColor(sb)) {
                // 彩球+彩球 = 全盘清屏
                for (let r = 0; r < ROWS; r++)
                    for (let c = 0; c < COLS; c++) addCell(r, c);
                console.log(`[B4] 组合激活 类型=彩球+彩球 清${cells.size}格`);
            }
// B3 修复: 标记两个特效格已激活，防止 expandSpecialSplash 重复触发
this._activatedSpecials.add(`${a.row},${a.col}`);
this._activatedSpecials.add(`${b.row},${b.col}`);
this.tileSpecials[a.row][a.col] = SpecialType.NONE;
this.tileSpecials[b.row][b.col] = SpecialType.NONE;
// 特效主动引爆 → 通知 GameManager 计数（2 个特效各算 1 次）
this.callbacks.onSpecialDetonated?.();
this.callbacks.onSpecialDetonated?.();
// 激活 juice：放大爆裂 + 粒子 + 震动 + 音效
this.playSpecialBurst(a.row, a.col, sa);
this.playSpecialBurst(b.row, b.col, sb);
// 移除视觉层（tile 即将被 destroyCellSet 销毁，提前清视觉避免残留闪烁）
const tileA = this.tiles[a.row]?.[a.col];
const tileB = this.tiles[b.row]?.[b.col];
if (tileA) this.removeSpecialVisual(tileA);
if (tileB) this.removeSpecialVisual(tileB);
return cells;
        }

        // ── 一个 COLOR_BOMB + 一个普通 → 清该色全盘 + 彩球自身 ──
        if (isColor(sa) || isColor(sb)) {
            const normalPos = isColor(sa) ? b : a;
            const bombPos = isColor(sa) ? a : b;
            const targetColor = this.grid[normalPos.row]?.[normalPos.col] ?? this.getMostCommonColor();
            console.log(`[B3] 彩球激活(主动) 目标色=${targetColor}`);
            for (let r = 0; r < ROWS; r++)
                for (let c = 0; c < COLS; c++)
                    if (this.grid[r] && this.grid[r][c] === targetColor) addCell(r, c);
            addCell(bombPos.row, bombPos.col);
// B3 修复: 彩球主动激活后立即标记+清特效，防止 expandSpecialSplash 被动二次触发
this._activatedSpecials.add(`${bombPos.row},${bombPos.col}`);
this.tileSpecials[bombPos.row][bombPos.col] = SpecialType.NONE;
// 特效主动引爆 → 通知 GameManager 计数（1 个彩球）
this.callbacks.onSpecialDetonated?.();
// 激活 juice
this.playSpecialBurst(bombPos.row, bombPos.col, SpecialType.COLOR_BOMB);
// 移除视觉层
const tileBomb = this.tiles[bombPos.row]?.[bombPos.col];
if (tileBomb) this.removeSpecialVisual(tileBomb);
return cells;
        }

        // ── 一个 LINE/BOMB + 一个普通 → 走普通匹配（特效格可能被波及而被动激活）──
        return null;
    }

    /** B3/B4: 从 Set<string> 销毁所有格（动画 + 清理数据），与 eliminateMatches 逻辑一致 */
    private async destroyCellSet(cells: Set<string>): Promise<void> {
        const promises: Promise<void>[] = [];
        let destroyedCount = 0;

        for (const key of cells) {
            const [row, col] = key.split(',').map(Number);
            if (!isFinite(row) || !isFinite(col)) continue;
            const tileNode = this.tiles[row]?.[col];
            // B4 修复: 加 isValid 检查，跳过已销毁/失效节点
            if (!tileNode || !tileNode.isValid) {
                // B4 修复: 清理悬空引用
                this.grid[row][col] = -1;
                this.tiles[row][col] = null;
                this.tileSpecials[row][col] = SpecialType.NONE;
                continue;
            }

            // B4 修复: 先从矩阵移除引用，再销毁，避免本帧后续逻辑碰到悬空引用
            const eliminatedColor = this.grid[row][col];
            if (eliminatedColor >= 0) this.callbacks.onTileEliminated?.(eliminatedColor);
            this.grid[row][col] = -1;
            this.tiles[row][col] = null;
            this.tileSpecials[row][col] = SpecialType.NONE;
            this.tileInfoMap.delete(tileNode);
            destroyedCount++;

            const opacity = tileNode.getComponent(UIOpacity) ?? tileNode.addComponent(UIOpacity);
            promises.push(
                new Promise<void>(resolve => {
                    tween(tileNode)
                        .to(Board.ELIMINATE_SCALE_UP, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'backOut' })
                        .to(Board.ELIMINATE_SCALE_DOWN, { scale: new Vec3(0, 0, 0) }, { easing: 'quadIn' })
                        .start();
                    tween(opacity)
                        .delay(Board.ELIMINATE_SCALE_UP)
                        .to(Board.ELIMINATE_SCALE_DOWN, { opacity: 0 })
                        .call(() => { tileNode.destroy(); resolve(); })
                        .start();
                }),
            );
        }

        // 计分
        let baseScore = destroyedCount * 10;
        if (destroyedCount >= 4) baseScore += 20;
        this.totalScore += baseScore;
        this.callbacks.onScoreChange?.(this.totalScore);
        console.log(`[Board] 特效销毁 ${destroyedCount} 格 +${baseScore}分`);

        AudioManager.inst?.playMatch();
        destroyedCount >= 4 ? VibrateManager.inst?.medium() : VibrateManager.inst?.light();
        await Promise.all(promises);
    }

    private async performSwap(a: TileInfo, b: TileInfo): Promise<void> {
        const tileA = this.tiles[a.row]?.[a.col];
        const tileB = this.tiles[b.row]?.[b.col];
        // B4 修复: 加 isValid 检查
        if (!tileA || !tileB || !tileA.isValid || !tileB.isValid) return;

        const posA = this.tileToLocalPosition(a.row, a.col);
        const posB = this.tileToLocalPosition(b.row, b.col);

        // 交换 grid 数据
        const tmp = this.grid[a.row][a.col];
        this.grid[a.row][a.col] = this.grid[b.row][b.col];
        this.grid[b.row][b.col] = tmp;

        // 交换 tileSpecials（B2/B3/B4: 特效必须跟着方块走）
        const tmpS = this.tileSpecials[a.row][a.col];
        this.tileSpecials[a.row][a.col] = this.tileSpecials[b.row][b.col];
        this.tileSpecials[b.row][b.col] = tmpS;

        // 交换 tiles 引用
        this.tiles[a.row][a.col] = tileB;
        this.tiles[b.row][b.col] = tileA;

        // 更新反查 Map
        this.tileInfoMap.set(tileA, { row: b.row, col: b.col });
        this.tileInfoMap.set(tileB, { row: a.row, col: a.col });

        // 同步 TileGesture 的 row/col
        const ga = tileA.getComponent(TileGesture);
        if (ga) { ga.row = b.row; ga.col = b.col; }
        const gb = tileB.getComponent(TileGesture);
        if (gb) { gb.row = a.row; gb.col = a.col; }

        tileA.name = `Tile_${b.row}_${b.col}`;
        tileB.name = `Tile_${a.row}_${a.col}`;

        AudioManager.inst?.playSwap();
        await Promise.all([
            this.tweenPromise(tileA, Board.SWAP_DURATION, { position: posB }, 'quadOut'),
            this.tweenPromise(tileB, Board.SWAP_DURATION, { position: posA }, 'quadOut'),
        ]);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  匹配检测
    // ══════════════════════════════════════════════════════════════════════════

    private findMatches(): Array<{ row: number; col: number }> {
        const { ROWS, COLS } = Board;
        const matched = new Set<string>();

        // 横向
        for (let r = 0; r < ROWS; r++) {
            let runStart = 0;
            for (let c = 1; c <= COLS; c++) {
                if (c === COLS || this.grid[r][c] !== this.grid[r][runStart]) {
                    if (c - runStart >= 3 && this.grid[r][runStart] >= 0) {
                        for (let k = runStart; k < c; k++) matched.add(`${r},${k}`);
                    }
                    runStart = c;
                }
            }
        }

        // 纵向
        for (let c = 0; c < COLS; c++) {
            let runStart = 0;
            for (let r = 1; r <= ROWS; r++) {
                if (r === ROWS || this.grid[r][c] !== this.grid[runStart][c]) {
                    if (r - runStart >= 3 && this.grid[runStart][c] >= 0) {
                        for (let k = runStart; k < r; k++) matched.add(`${k},${c}`);
                    }
                    runStart = r;
                }
            }
        }

        return Array.from(matched).map(s => {
            const [row, col] = s.split(',').map(Number);
            return { row, col };
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  B0 · 匹配分组 + 形状识别
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 找出所有 ≥3 连续同色的横/竖线段，按交叉点合并为组，识别每组的形状。
     * - 横竖线段在交叉格重叠 → 合并为一组（L/T 形）
     * - 每组记录 cells + colorId + shape
     */
    private findMatchGroups(): MatchGroup[] {
        const { ROWS, COLS } = Board;

        // 1. 收集所有横向 run（≥3）
        const hRuns: Array<{ r: number; c0: number; c1: number; color: number }> = [];
        for (let r = 0; r < ROWS; r++) {
            let runStart = 0;
            for (let c = 1; c <= COLS; c++) {
                if (c === COLS || this.grid[r][c] !== this.grid[r][runStart]) {
                    const len = c - runStart;
                    if (len >= 3 && this.grid[r][runStart] >= 0) {
                        hRuns.push({ r, c0: runStart, c1: c - 1, color: this.grid[r][runStart] });
                    }
                    runStart = c;
                }
            }
        }

        // 2. 收集所有纵向 run（≥3）
        const vRuns: Array<{ c: number; r0: number; r1: number; color: number }> = [];
        for (let c = 0; c < COLS; c++) {
            let runStart = 0;
            for (let r = 1; r <= ROWS; r++) {
                if (r === ROWS || this.grid[r][c] !== this.grid[runStart][c]) {
                    const len = r - runStart;
                    if (len >= 3 && this.grid[runStart][c] >= 0) {
                        vRuns.push({ c, r0: runStart, r1: r - 1, color: this.grid[runStart][c] });
                    }
                    runStart = r;
                }
            }
        }

        // 3. 用 Union-Find 合并横竖线段（交叉点同色 → 同组）
        //    每个 run 是一个节点，横竖 run 交叉且同色 → 合并
        const allRuns = [
            ...hRuns.map(r => ({ type: 'h' as const, data: r })),
            ...vRuns.map(r => ({ type: 'v' as const, data: r })),
        ];
        const parent = allRuns.map((_, i) => i);
        const find = (x: number): number => {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        };
        const union = (a: number, b: number) => { parent[find(a)] = find(b); };

        // 横 run i 与竖 run j 交叉 → 合并
        for (let i = 0; i < hRuns.length; i++) {
            for (let j = 0; j < vRuns.length; j++) {
                const h = hRuns[i];
                const v = vRuns[j];
                if (h.color !== v.color) continue;
                // 交叉点：(h.r, v.c)，必须在横 run 和竖 run 范围内
                if (h.r >= v.r0 && h.r <= v.r1 && v.c >= h.c0 && v.c <= h.c1) {
                    union(i, hRuns.length + j);
                }
            }
        }

        // 4. 按 root 分组，收集 cells + 判定形状
        const groupMap = new Map<number, { hRuns: typeof hRuns; vRuns: typeof vRuns; color: number }>();
        for (let i = 0; i < allRuns.length; i++) {
            const root = find(i);
            if (!groupMap.has(root)) {
                groupMap.set(root, { hRuns: [], vRuns: [], color: -1 });
            }
            const g = groupMap.get(root)!;
            g.color = allRuns[i].data.color;
            if (allRuns[i].type === 'h') g.hRuns.push(allRuns[i].data as typeof hRuns[number]);
            else g.vRuns.push(allRuns[i].data as typeof vRuns[number]);
        }

        // 5. 对每组：收集 cells（去重）+ 判定形状
        const groups: MatchGroup[] = [];
        for (const [, g] of groupMap) {
            const cellSet = new Set<string>();
            for (const h of g.hRuns) {
                for (let c = h.c0; c <= h.c1; c++) cellSet.add(`${h.r},${c}`);
            }
            for (const v of g.vRuns) {
                for (let r = v.r0; r <= v.r1; r++) cellSet.add(`${r},${v.c}`);
            }

            const cells = Array.from(cellSet).map(s => {
                const [row, col] = s.split(',').map(Number);
                return { row, col };
            });

            // 判定形状
            const maxHLen = g.hRuns.length > 0 ? Math.max(...g.hRuns.map(h => h.c1 - h.c0 + 1)) : 0;
            const maxVLen = g.vRuns.length > 0 ? Math.max(...g.vRuns.map(v => v.r1 - v.r0 + 1)) : 0;
            const hasBoth = g.hRuns.length > 0 && g.vRuns.length > 0;

            let shape: MatchShape;
            if (maxHLen >= 5 || maxVLen >= 5) {
                shape = MatchShape.LINE_5;
            } else if (hasBoth) {
                shape = MatchShape.LT;   // L 或 T 形
            } else if (maxHLen >= 4) {
                shape = MatchShape.LINE_H_4;
            } else if (maxVLen >= 4) {
                shape = MatchShape.LINE_V_4;
            } else {
                shape = MatchShape.NORMAL;
            }

            groups.push({ cells, colorId: g.color, shape });
        }

        return groups;
    }

    /**
     * 将匹配形状映射为特效类型（⚠️方向反直觉）。
     * - 横向 4 连 → LINE_V（竖条，消一列）
     * - 纵向 4 连 → LINE_H（横条，消一行）
     * - L/T 形 → BOMB
     * - 直线 ≥5 → COLOR_BOMB
     * - 普通 3 连 → NONE（不生成特效）
     */
    private shapeToSpecial(shape: MatchShape): SpecialType {
        switch (shape) {
            case MatchShape.LINE_H_4: return SpecialType.LINE_V;  // 横4→竖条
            case MatchShape.LINE_V_4: return SpecialType.LINE_H;  // 竖4→横条
            case MatchShape.LT:        return SpecialType.BOMB;
            case MatchShape.LINE_5:     return SpecialType.COLOR_BOMB;
            default:                   return SpecialType.NONE;
        }
    }

    /** 在一组匹配中选特效落点：优先玩家本次交换的格子，否则取该组第一格 */
    private pickSpawnCell(group: MatchGroup): { row: number; col: number } {
        for (const cell of group.cells) {
            for (const swap of this._lastSwapCells) {
                if (cell.row === swap.row && cell.col === swap.col) {
                    return cell;
                }
            }
        }
        return group.cells[0];
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  可行步检测器（纯逻辑，不动画/不真改节点）
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 遍历棋盘，模拟每对相邻格交换，检测是否产生 ≥3 连线。
     * 只试「右侧」和「下方」两个方向，覆盖所有相邻对不重复。
     * 返回第一个找到的可行步；全盘无解返回 null。
     */
    public findAnyValidMove(): { a: { r: number; c: number }; b: { r: number; c: number } } | null {
        const { ROWS, COLS } = Board;
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                // 越界保护
                if (!this.grid[r] || this.grid[r][c] === undefined) continue;

                // 试右侧
                if (c + 1 < COLS && this.grid[r][c + 1] !== undefined) {
                    const va = this.grid[r][c];
                    const vb = this.grid[r][c + 1];
                    // 模拟交换
                    this.grid[r][c] = vb;
                    this.grid[r][c + 1] = va;
                    const has = this.findMatches().length > 0;
                    // 换回
                    this.grid[r][c] = va;
                    this.grid[r][c + 1] = vb;
                    if (has) {
                        return { a: { r, c }, b: { r, c: c + 1 } };
                    }
                }

                // 试下方
                if (r + 1 < ROWS && this.grid[r + 1] && this.grid[r + 1][c] !== undefined) {
                    const va = this.grid[r][c];
                    const vb = this.grid[r + 1][c];
                    // 模拟交换
                    this.grid[r][c] = vb;
                    this.grid[r + 1][c] = va;
                    const has = this.findMatches().length > 0;
                    // 换回
                    this.grid[r][c] = va;
                    this.grid[r + 1][c] = vb;
                    if (has) {
                        return { a: { r, c }, b: { r: r + 1, c } };
                    }
                }
            }
        }
        return null;
    }

    /** 便捷判断：当前棋盘是否有可行步 */
    public hasAnyValidMove(): boolean {
        // 调试：临时强制死局（5秒有效，由 testDeadlock 触发）
        if (typeof window !== 'undefined' && (window as any).__debugForceDeadlock__) {
            console.log('[DEBUG] ⚠ hasAnyValidMove 被强制返回 false（死局模拟）');
            return false;
        }
        return this.findAnyValidMove() !== null;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  A3 · 开局/切关保证有可行步且无自动消（静默，无提示）
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 静默保证当前棋盘「无现成三连 && 有可行步」。
     * - 同步执行（无 tween 动画），用于开局/切关时 generateBoard() 之后。
     * - Fisher-Yates 打乱数据 + 瞬间移动节点位置。
     * - 最多重试 20 次，超限则 forceRegenerateBoard()。
     * - 不显示「重新洗牌」提示文字（玩家还没开始玩）。
     */
    private ensureValidBoard(): void {
        const { ROWS, COLS } = Board;
        const MAX_RETRIES = 20;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const hasMatch = this.findMatches().length > 0;
            const hasMove = this.findAnyValidMove() !== null;

            if (!hasMatch && hasMove) {
                if (attempt > 0) {
                    console.log(`[Board] ✓ 开局校验通过（第 ${attempt + 1} 次洗牌后）`);
                }
                return;
            }

            console.log(`[Board] 开局校验失败(尝试 ${attempt + 1}/${MAX_RETRIES}): 有三连=${hasMatch}, 有可行步=${hasMove}`);

            // 收集所有 (colorId, node, special) 对
            const pairs: { colorId: number; node: Node; special: SpecialType }[] = [];
            for (let r = 0; r < ROWS; r++) {
                for (let c = 0; c < COLS; c++) {
                    if (this.grid[r]
                        && this.grid[r][c] !== undefined
                        && this.grid[r][c] >= 0
                        && this.tiles[r][c]) {
                        pairs.push({ colorId: this.grid[r][c], node: this.tiles[r][c], special: this.tileSpecials[r][c] });
                    }
                }
            }
            if (pairs.length === 0) break;

            // Fisher-Yates 洗牌
            for (let i = pairs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
            }

            // 重新赋值到 grid / tiles / tileSpecials / tileInfoMap / TileGesture + 瞬间移动节点
            let idx = 0;
            for (let r = 0; r < ROWS; r++) {
                for (let c = 0; c < COLS; c++) {
                    if (idx >= pairs.length) break;
                    const { colorId, node, special } = pairs[idx];
                    this.grid[r][c] = colorId;
                    this.tiles[r][c] = node;
                    this.tileSpecials[r][c] = special;
                    this.tileInfoMap.set(node, { row: r, col: c });
                    node.name = `Tile_${r}_${c}`;
                    const gs = node.getComponent(TileGesture);
                    if (gs) { gs.row = r; gs.col = c; }
                    // 瞬间移动到新位置（无动画）
                    node.setPosition(this.tileToLocalPosition(r, c));
                    idx++;
                }
            }

            if (attempt === MAX_RETRIES - 1) {
                // 超限兜底：强制重生成棋盘
                console.log('[Board] ⚠ 开局校验超限，强制重生成');
                this.forceRegenerateBoard();
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  A2 · 无解自动洗牌
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 洗牌：重排棋盘上现有元素（打乱位置、不新增种类），循环直到有可行步且无现成三连。
     * - 先显示「重新洗牌」提示 + 整盘轻抖
     * - Fisher-Yates 打乱 (colorId, node) 对
     * - 重排后检测：无现成匹配 && hasAnyValidMove
     * - 最多重试 20 次，超限则强制重生成
     * - 最后用 tween 动画把所有方块滑到新位置
     */
    private async shuffleBoardWithHint(): Promise<void> {
        const { ROWS, COLS } = Board;
        // 调试：临时把上限改成 1，测试 forceRegenerateBoard 路径
        const MAX_RETRIES = (typeof window !== 'undefined' && (window as any).__debugForceRegenLimit__) ? 1 : 20;

        // 提示文字 + 轻抖
        this.showShuffleHint();
        this.shakeBoard(4);

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            // 收集所有 (colorId, node, special) 对
            const pairs: { colorId: number; node: Node; special: SpecialType }[] = [];
            for (let r = 0; r < ROWS; r++) {
                for (let c = 0; c < COLS; c++) {
                    if (this.grid[r]
                        && this.grid[r][c] !== undefined
                        && this.grid[r][c] >= 0
                        && this.tiles[r][c]) {
                        pairs.push({ colorId: this.grid[r][c], node: this.tiles[r][c], special: this.tileSpecials[r][c] });
                    }
                }
            }
            if (pairs.length === 0) {
                // B4 修复: 空盘兜底 — 棋盘被大范围清空后无残留方块，直接重生成
                console.log('[Board] ⚠ 洗牌时棋盘为空（pairs=0），强制重生成');
                this.forceRegenerateBoard();
                break;
            }

            // Fisher-Yates 洗牌
            for (let i = pairs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
            }

            // 重新赋值到 grid / tiles / tileSpecials / tileInfoMap / TileGesture
            let idx = 0;
            for (let r = 0; r < ROWS; r++) {
                for (let c = 0; c < COLS; c++) {
                    if (idx >= pairs.length) break;
                    const { colorId, node, special } = pairs[idx];
                    this.grid[r][c] = colorId;
                    this.tiles[r][c] = node;
                    this.tileSpecials[r][c] = special;
                    this.tileInfoMap.set(node, { row: r, col: c });
                    node.name = `Tile_${r}_${c}`;
                    const gs = node.getComponent(TileGesture);
                    if (gs) { gs.row = r; gs.col = c; }
                    idx++;
                }
            }

            // 检测：无现成匹配 && 有可行步
            const hasMatch = this.findMatches().length > 0;
            const hasMove = this.hasAnyValidMove();
            console.log(`[Board] 洗牌尝试 ${attempt + 1}/${MAX_RETRIES}: 有现成匹配=${hasMatch}, 有可行步=${hasMove}`);

            if (!hasMatch && hasMove) {
                console.log('[Board] ✓ 洗牌成功');
                break;
            }

            if (attempt === MAX_RETRIES - 1) {
                // 超限兜底：强制重生成棋盘
                console.log('[Board] ⚠ 洗牌超限，强制重生成');
                this.forceRegenerateBoard();
            }
        }

        // 动画：所有方块滑到新位置
        const promises: Promise<void>[] = [];
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const node = this.tiles[r]?.[c];
                if (!node) continue;
                const targetPos = this.tileToLocalPosition(r, c);
                promises.push(this.tweenPromise(node, 0.3, { position: targetPos }, 'quadOut'));
            }
        }
        await Promise.all(promises);

        console.log('[Board] 洗牌完成，hasAnyValidMove =', this.hasAnyValidMove());
    }

    /** 洗牌超限兜底：销毁所有方块后用 pickSafeColor 重生成（保证无三连） */
    private forceRegenerateBoard(): void {
        const { ROWS, COLS } = Board;
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const node = this.tiles[r]?.[c];
                if (node) {
                    Tween.stopAllByTarget(node);
                    node.destroy();
                }
            }
        }
        this.grid = [];
        this.tiles = [];
        this.tileInfoMap.clear();
        this.selectedTile = null;

        // 直接调 generateBoard（内部用 pickSafeColor 保证无三连）
        for (let r = 0; r < ROWS; r++) {
            this.grid[r] = [];
            this.tiles[r] = [];
            this.tileSpecials[r] = [];
            for (let c = 0; c < COLS; c++) {
                const colorId = this.pickSafeColor(r, c);
                const tileNode = this.createTileNode(r, c, colorId);
                this.grid[r][c] = colorId;
                this.tiles[r][c] = tileNode;
                this.tileSpecials[r][c] = SpecialType.NONE;
                this.tileInfoMap.set(tileNode, { row: r, col: c });
            }
        }
        console.log('[Board] 强制重生成完成');
        this.ensureEffectsLayer();  // C2: 确保特效层在方块之上
    }

    /** 「重新洗牌」提示文字：弹入 + 上浮 + 淡出 */
    private showShuffleHint(): void {
        const hintNode = new Node('ShuffleHint');
        hintNode.parent = this.ensureEffectsLayer();
        hintNode.setPosition(0, 0, 0);

        const ut = hintNode.addComponent(UITransform);
        ut.setContentSize(300, 60);

        const label = hintNode.addComponent(Label);
        label.string = '🔀 重新洗牌';
        label.fontSize = 36;
        label.lineHeight = 40;
        label.color = new Color(255, 255, 255);
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.NONE;

        const opacity = hintNode.addComponent(UIOpacity);
        hintNode.setScale(0.5, 0.5, 1);

        // scale 弹入 0.5→1.2→1.0
        tween(hintNode)
            .to(0.15, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'backOut' })
            .to(0.1, { scale: new Vec3(1.0, 1.0, 1) })
            .start();

        // 上浮 50px
        tween(hintNode)
            .by(0.8, { position: new Vec3(0, 50, 0) })
            .start();

        // 淡出 + 销毁
        tween(opacity)
            .delay(0.4)
            .to(0.4, { opacity: 0 })
            .call(() => hintNode.destroy())
            .start();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  连锁消除循环
    // ══════════════════════════════════════════════════════════════════════════

    private async processChain(): Promise<void> {
        let chainCount = 0;

        while (true) {
            const groups = this.findMatchGroups();
            if (groups.length === 0) break;

            chainCount++;

            // 合并所有组的 cells（去重）用于计分
            const allCells = new Set<string>();
            for (const g of groups) {
                for (const c of g.cells) allCells.add(`${c.row},${c.col}`);
            }
            const matchCount = allCells.size;

            // 计分（核心逻辑不变）
            let baseScore = matchCount * 10;
            if (matchCount >= 4) baseScore += 20;
            const multiplier = 1 + 0.5 * (chainCount - 1);
            const segmentScore = Math.round(baseScore * multiplier);
            this.totalScore += segmentScore;

            console.log(
                `[Board] 连锁第 ${chainCount} 段 | 消除 ${matchCount} 个 | ` +
                `基础 ${baseScore} | 倍率 ${multiplier.toFixed(1)}x | ` +
                `本段 +${segmentScore} | 总分 ${this.totalScore}`,
            );

            // 通知 GameManager 分数变化
            this.callbacks.onScoreChange?.(this.totalScore);

            // ★ COMBO 弹字（连锁第 2 段起）
            if (chainCount >= 2) {
                this.showComboLabel(chainCount, Array.from(allCells).map(s => {
                    const [row, col] = s.split(',').map(Number);
                    return { row, col };
                }));
                AudioManager.inst?.playCombo(chainCount);
                // 连锁震动：n>=4 heavy，否则 medium
                chainCount >= 4 ? VibrateManager.inst?.heavy() : VibrateManager.inst?.medium();
            }

            // C2: 连锁震屏分级 — n≥2 轻震(4)、n≥4 强震(6)
            if (chainCount >= 4) {
                this.shakeBoard(6);
            } else if (chainCount >= 2 || matchCount >= 4) {
                this.shakeBoard(4);
            }

            await this.eliminateMatches(groups, chainCount);
            await this.applyGravity();

            // 清除本次交换记录（连锁产生的消除不再用原交换格做落点）
            this._lastSwapCells = [];
        }

        if (chainCount > 0) {
            console.log(`[Board] ═══ 连锁结束，当前总分: ${this.totalScore} ═══`);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  B1 · 特效引爆展开（LINE_H 清行 / LINE_V 清列，连环引爆）
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * BFS 展开待消集合：遍历集合中的特效格，按类型展开。
     * - LINE_H → 清整行
     * - LINE_V → 清整列
     * - BOMB → 3×3 共 9 格
     * - COLOR_BOMB(被动) → 清最多色全盘 + 彩球自身
     * 新加入的格若也是特效格 → 继续展开（连环引爆），直到无新增。
     * 不递归、不爆栈，纯迭代。
     */
    private expandSpecialSplash(destroyedCells: Set<string>): void {
        const { ROWS, COLS } = Board;
        const queue = Array.from(destroyedCells);
        const processed = new Set<string>();

        // 工具：安全添加一格（越界跳过、去重入队）
        const addCell = (r: number, c: number) => {
            if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
            const k = `${r},${c}`;
            if (!destroyedCells.has(k)) {
                destroyedCells.add(k);
                queue.push(k);
            }
        };

        while (queue.length > 0) {
            const key = queue.shift()!;
            if (processed.has(key)) continue;
            processed.add(key);

            // B3 修复: 跳过本轮已主动激活的特效格（防双重触发）
            if (this._activatedSpecials.has(key)) continue;

            const [r, c] = key.split(',').map(Number);
            if (!isFinite(r) || !isFinite(c)) continue;
            if (!this.tileSpecials[r] || this.tileSpecials[r][c] === undefined) continue;

            const special = this.tileSpecials[r][c];
            if (special === SpecialType.NONE) continue;

            // 特效被引爆 → 通知 GameManager 计数
            this.callbacks.onSpecialDetonated?.();
            // 激活 juice：放大爆裂 + 粒子 + 震动 + 音效
            this.playSpecialBurst(r, c, special);

            if (special === SpecialType.LINE_H) {
                console.log(`[Board] 💥 特效引爆: (${r},${c}) = LINE_H`);
                for (let cc = 0; cc < COLS; cc++) addCell(r, cc);
            } else if (special === SpecialType.LINE_V) {
                console.log(`[Board] 💥 特效引爆: (${r},${c}) = LINE_V`);
                for (let rr = 0; rr < ROWS; rr++) addCell(rr, c);
            } else if (special === SpecialType.BOMB) {
                // B2: 以 (r,c) 为中心 3×3
                let cnt = 0;
                for (let dr = -1; dr <= 1; dr++)
                    for (let dc = -1; dc <= 1; dc++) { addCell(r + dr, c + dc); cnt++; }
                console.log(`[B2] 炸弹激活 (${r},${c}) 清${cnt}格`);
            } else if (special === SpecialType.COLOR_BOMB) {
                // B3: 被动引爆 — 清最多色全盘 + 彩球自身
                const targetColor = this.getMostCommonColor();
                let cnt = 0;
                for (let rr = 0; rr < ROWS; rr++)
                    for (let cc = 0; cc < COLS; cc++)
                        if (this.grid[rr] && this.grid[rr][cc] === targetColor) { addCell(rr, cc); cnt++; }
                addCell(r, c); // 彩球自身
                console.log(`[B3] 彩球激活(被动) (${r},${c}) 目标色=${targetColor} 清${cnt}格`);
            }
        }

        if (processed.size > 1) {
            console.log(`[Board] 特效引爆展开完成，待消集合: ${destroyedCells.size} 格`);
        }
    }

    /** B3: 统计当前棋盘上数量最多的颜色 */
    private getMostCommonColor(): number {
        const counts: number[] = new Array(Board.COLORS.length).fill(0);
        for (let r = 0; r < Board.ROWS; r++)
            for (let c = 0; c < Board.COLS; c++)
                if (this.grid[r] && this.grid[r][c] >= 0) counts[this.grid[r][c]]++;
        let maxC = 0, maxColor = 0;
        for (let i = 0; i < counts.length; i++)
            if (counts[i] > maxC) { maxC = counts[i]; maxColor = i; }
        return maxColor;
    }

    private async eliminateMatches(groups: MatchGroup[], chainCount: number = 0): Promise<void> {
        const promises: Promise<void>[] = [];
        const destroyedCells = new Set<string>();

        // 收集所有要生成的特效（落点格不销毁）
        const spawns: Array<{ row: number; col: number; special: SpecialType; colorId: number }> = [];

        for (const group of groups) {
            const special = this.shapeToSpecial(group.shape);
            if (special === SpecialType.NONE) {
                // 普通组：全部销毁
                for (const cell of group.cells) {
                    destroyedCells.add(`${cell.row},${cell.col}`);
                }
            } else {
                // 特效组：选落点格保留，其余销毁
                const spawn = this.pickSpawnCell(group);
                spawns.push({ row: spawn.row, col: spawn.col, special, colorId: group.colorId });
                console.log(`[Board] ★ 生成特效: ${SpecialType[special]} 于 (${spawn.row},${spawn.col}) | shape=${MatchShape[group.shape]}`);
                for (const cell of group.cells) {
                    if (cell.row === spawn.row && cell.col === spawn.col) continue;
                    destroyedCells.add(`${cell.row},${cell.col}`);
                }
            }
        }

        // ★ B1: 展开特效引爆（LINE_H 清行 / LINE_V 清列，连环引爆）
        this.expandSpecialSplash(destroyedCells);

        // 销毁所有待消格
        for (const key of destroyedCells) {
            const [row, col] = key.split(',').map(Number);
            if (!isFinite(row) || !isFinite(col)) continue;
            const tileNode = this.tiles[row]?.[col];
            // B4 修复: 加 isValid 检查，跳过已销毁/失效节点
            if (!tileNode || !tileNode.isValid) {
                // B4 修复: 清理悬空引用
                this.grid[row][col] = -1;
                this.tiles[row][col] = null;
                this.tileSpecials[row][col] = SpecialType.NONE;
                continue;
            }

            // B4 修复: 先从矩阵移除引用，再销毁
            const eliminatedColor = this.grid[row][col];
            if (eliminatedColor >= 0) this.callbacks.onTileEliminated?.(eliminatedColor);
            this.grid[row][col] = -1;
            this.tiles[row][col] = null;
            this.tileSpecials[row][col] = SpecialType.NONE;
            this.tileInfoMap.delete(tileNode);

            // 确保 UIOpacity 存在（用于淡出）
            const opacity = tileNode.getComponent(UIOpacity) ?? tileNode.addComponent(UIOpacity);

            promises.push(
                new Promise<void>(resolve => {
                    // 先快速放大 1.15（0.06s）再缩 0 + 淡出（0.14s）
                    tween(tileNode)
                        .to(Board.ELIMINATE_SCALE_UP, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'backOut' })
                        .to(Board.ELIMINATE_SCALE_DOWN, { scale: new Vec3(0, 0, 0) }, { easing: 'quadIn' })
                        .start();

                    tween(opacity)
                        .delay(Board.ELIMINATE_SCALE_UP)
                        .to(Board.ELIMINATE_SCALE_DOWN, { opacity: 0 })
                        .call(() => {
                            tileNode.destroy();
                            resolve();
                        })
                        .start();
                }),
            );
        }

        // 生成特效格（保留节点，改标记 + 加占位视觉）
        for (const spawn of spawns) {
            // ★ B1: 落点被引爆波及则跳过（该格已被清行/列）
            if (destroyedCells.has(`${spawn.row},${spawn.col}`)) {
                console.log(`[Board] 特效落点被波及，跳过生成: (${spawn.row},${spawn.col})`);
                continue;
            }
            this.tileSpecials[spawn.row][spawn.col] = spawn.special;
            this.applySpecialVisual(spawn.row, spawn.col, spawn.special);
        }

        // 连锁≥2段时 combo 音已在 processChain 里播了，这里不重复播 match
        if (chainCount < 2) AudioManager.inst?.playMatch();
        // 消除震动：≥4 个用 medium，否则 light
        const matchCount = destroyedCells.size + spawns.length;
        matchCount >= 4 ? VibrateManager.inst?.medium() : VibrateManager.inst?.light();
        await Promise.all(promises);
    }

    /**
     * 贴图叠加版：给特效格叠加贴图 + 颜色环 + scrim + juice 动画。
     * LINE_H → fx_line (angle=0) / LINE_V → fx_line (angle=90)
     * BOMB → fx_bomb / COLOR_BOMB → fx_colorbomb（整块覆盖）
     * 贴图缺失时走 Graphics fallback，不报错。
     */
    private applySpecialVisual(row: number, col: number, special: SpecialType): void {
        const tileNode = this.tiles[row]?.[col];
        if (!tileNode || !tileNode.isValid || special === SpecialType.NONE) return;

        // 移除旧视觉
        this.removeSpecialVisual(tileNode);

        const ts = Board.TILE_SIZE;
        const safeTs = (typeof ts === 'number' && !isNaN(ts) && isFinite(ts) && ts > 0) ? ts : 70;
        const isColorBomb = special === SpecialType.COLOR_BOMB;
        // Fix 2: fx 贴图放大到占格子 80-90%
        const overlayScale = isColorBomb ? 0.9 : 0.85;
        const overlaySize = safeTs * overlayScale;

        // ── 主容器 SpecialMark ──
        const markNode = new Node('SpecialMark');
        markNode.parent = tileNode;
        markNode.setPosition(0, 0, 0);
        const ut = markNode.addComponent(UITransform);
        ut.setContentSize(safeTs, safeTs);

        // ── fxOverlay 贴图（贴图成功时只显示贴图，不画灰圆/scrim/colorRing）──
        const frame = this.getSpecialFrame(special);
        if (frame) {
            const fxNode = new Node('fxOverlay');
            fxNode.parent = markNode;
            fxNode.setPosition(0, 0, 0);
            const fxUT = fxNode.addComponent(UITransform);
            fxUT.setAnchorPoint(0.5, 0.5);
            fxUT.setContentSize(256, 256);
            const fxSprite = fxNode.addComponent(Sprite);
            fxSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            fxSprite.trim = false;
            fxSprite.spriteFrame = frame;
            fxUT.setContentSize(256, 256);
            const s = overlaySize / 256;
            fxNode.setScale(s, s, 1);
            if (special === SpecialType.LINE_V) fxNode.angle = 90;
            const fxOp = fxNode.addComponent(UIOpacity);
            fxOp.opacity = 255;  // Fix 2: 不透明
        } else {
            // Fix 3: 贴图缺失时才画 Graphics fallback（灰圆/占位）
            this.drawFallbackSpecial(markNode, special, overlaySize);
        }

        // ── Juice: 生成时 backOut 弹入 + 呼吸脉冲 ──
        markNode.setScale(0, 0, 1);
        tween(markNode)
            .to(0.25, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'backOut' })
            .to(0.08, { scale: new Vec3(1, 1, 1) })
            .call(() => {
                // Fix 2: 呼吸 1→1.1→1 循环 0.8s
                tween(markNode)
                    .to(0.4, { scale: new Vec3(1.1, 1.1, 1) }, { easing: 'sineOut' })
                    .to(0.4, { scale: new Vec3(1.0, 1.0, 1) }, { easing: 'sineIn' })
                    .union()
                    .repeatForever()
                    .start();
            })
            .start();

        // 彩球额外：缓慢旋转
        if (isColorBomb) {
            tween(markNode)
                .by(3, { angle: 360 })
                .repeatForever()
                .start();
        }

        // Fix 3: log 子节点确认无多余灰圆
        const childInfo = markNode.children.map(c => `${c.name}(active=${c.active})`).join(', ') || '(none)';
        console.log(`[Board] 特效视觉已叠加: (${row},${col}) = ${SpecialType[special]}, children=[${childInfo}]`);
    }

    /** 移除特效视觉层（停止动画 + 销毁节点） */
    private removeSpecialVisual(tileNode: Node): void {
        if (!tileNode || !tileNode.isValid) return;
        const mark = tileNode.getChildByName('SpecialMark');
        if (mark) {
            Tween.stopAllByTarget(mark);
            const op = mark.getComponent(UIOpacity);
            if (op) Tween.stopAllByTarget(op);
            // 停止子节点上的 tween
            for (const child of mark.children) {
                Tween.stopAllByTarget(child);
                const childOp = child.getComponent(UIOpacity);
                if (childOp) Tween.stopAllByTarget(childOp);
            }
            mark.destroy();
        }
    }

    /** Graphics fallback：贴图缺失时画占位特效（不报错） */
    private drawFallbackSpecial(markNode: Node, special: SpecialType, overlaySize: number): void {
        const g = markNode.addComponent(Graphics);
        const half = overlaySize / 2;
        const C_STROKE = new Color(0x4A, 0x2B, 0x6B);
        const C_BAR = new Color(255, 255, 255, 230);
        const C_ORANGE = new Color(0xFF, 0xB3, 0x00);

        switch (special) {
            case SpecialType.LINE_H: {
                const barH = 16;
                g.fillColor = C_BAR.clone();
                g.strokeColor = C_STROKE.clone();
                g.lineWidth = 2;
                g.roundRect(-half, -barH / 2, overlaySize, barH, barH / 2);
                g.fill(); g.stroke();
                break;
            }
            case SpecialType.LINE_V: {
                const barW = 16;
                g.fillColor = C_BAR.clone();
                g.strokeColor = C_STROKE.clone();
                g.lineWidth = 2;
                g.roundRect(-barW / 2, -half, barW, overlaySize, barW / 2);
                g.fill(); g.stroke();
                break;
            }
            case SpecialType.BOMB: {
                g.strokeColor = new Color(C_ORANGE.r, C_ORANGE.g, C_ORANGE.b, 60);
                g.lineWidth = 10;
                g.circle(0, 0, half * 0.7);
                g.stroke();
                g.strokeColor = C_ORANGE.clone();
                g.lineWidth = 3;
                g.circle(0, 0, half * 0.7);
                g.stroke();
                break;
            }
            case SpecialType.COLOR_BOMB: {
                const dotColors = [
                    new Color(0xFF, 0x4B, 0x4B), new Color(0xFF, 0xB3, 0x00),
                    new Color(0x4C, 0xD9, 0x6B), new Color(0x4B, 0x8B, 0xFF),
                    new Color(0xB0, 0x4B, 0xFF),
                ];
                const dotR = 8;
                const orbitR = half * 0.55;
                for (let i = 0; i < dotColors.length; i++) {
                    const angle = (i / dotColors.length) * Math.PI * 2 - Math.PI / 2;
                    const dx = Math.cos(angle) * orbitR;
                    const dy = Math.sin(angle) * orbitR;
                    g.strokeColor = C_STROKE.clone();
                    g.lineWidth = 2;
                    g.circle(dx, dy, dotR);
                    g.stroke();
                    g.fillColor = dotColors[i].clone();
                    g.circle(dx, dy, dotR);
                    g.fill();
                }
                g.fillColor = new Color(255, 255, 255, 220);
                g.ellipse(0, 0, 14, 5);
                g.fill();
                g.ellipse(0, 0, 5, 14);
                g.fill();
                break;
            }
        }
    }

    /** 激活 juice：fxOverlay 放大消失 + 粒子爆发 + 震动 + 音效 */
    private playSpecialBurst(row: number, col: number, special: SpecialType): void {
        if (special === SpecialType.NONE) return;
        const pos = this.tileToLocalPosition(row, col);
        const effectsLayer = this.ensureEffectsLayer();
        const ts = Board.TILE_SIZE;
        const safeTs = (typeof ts === 'number' && !isNaN(ts) && isFinite(ts) && ts > 0) ? ts : 70;
        const isColorBomb = special === SpecialType.COLOR_BOMB;
        // Fix 2: 与 applySpecialVisual 保持一致的放大比例
        const overlayScale = isColorBomb ? 0.9 : 0.85;
        const overlaySize = safeTs * overlayScale;

        // 1. fxOverlay 闪光放大（特效层临时 Sprite，0.2s 放大+消失）
        const frame = this.getSpecialFrame(special);
        if (frame) {
            const burst = new Node('burstFx');
            burst.parent = effectsLayer;
            burst.setPosition(pos);
            const burstUT = burst.addComponent(UITransform);
            burstUT.setAnchorPoint(0.5, 0.5);
            burstUT.setContentSize(256, 256);
            const burstSprite = burst.addComponent(Sprite);
            burstSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            burstSprite.trim = false;
            burstSprite.spriteFrame = frame;
            burstUT.setContentSize(256, 256);
            const s = overlaySize / 256;
            burst.setScale(s, s, 1);
            if (special === SpecialType.LINE_V) burst.angle = 90;
            const burstOp = burst.addComponent(UIOpacity);
            burstOp.opacity = 255;

            tween(burst)
                .to(0.2, { scale: new Vec3(s * 1.3, s * 1.3, 1) }, { easing: 'quadOut' })
                .start();
            tween(burstOp)
                .delay(0.1)
                .to(0.1, { opacity: 0 })
                .call(() => { if (burst.isValid) burst.destroy(); })
                .start();
        }

        // 2. 粒子爆发（8~12 白色星点外扩）
        const particleCount = isColorBomb ? 12 : 8;
        for (let i = 0; i < particleCount; i++) {
            const p = new Node('particle');
            p.parent = effectsLayer;
            p.setPosition(pos);
            const pUT = p.addComponent(UITransform);
            pUT.setAnchorPoint(0.5, 0.5);
            pUT.setContentSize(10, 10);
            const pSprite = p.addComponent(Sprite);
            pSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            pSprite.trim = false;
            pSprite.spriteFrame = this.whiteFrame;
            pUT.setContentSize(10, 10);
            p.setScale(0.8, 0.8, 1);

            const angle = (i / particleCount) * Math.PI * 2 + Math.random() * 0.3;
            const dist = 40 + Math.random() * 20;
            const dx = Math.cos(angle) * dist;
            const dy = Math.sin(angle) * dist;
            const pOp = p.addComponent(UIOpacity);
            pOp.opacity = 255;

            tween(p)
                .to(0.3, { position: new Vec3(pos.x + dx, pos.y + dy, 0) }, { easing: 'quadOut' })
                .start();
            tween(p)
                .delay(0.15)
                .to(0.15, { scale: new Vec3(0, 0, 1) })
                .call(() => { if (p.isValid) p.destroy(); })
                .start();
            tween(pOp)
                .to(0.3, { opacity: 0 })
                .start();
        }

        // 3. 震动（轻档；彩球/双特效用中档）
        if (isColorBomb) {
            VibrateManager.inst?.medium();
        } else {
            VibrateManager.inst?.light();
        }

        // 4. 音效
        if (special === SpecialType.LINE_H || special === SpecialType.LINE_V) {
            AudioManager.inst?.playSpecialLine();
        } else if (special === SpecialType.BOMB) {
            AudioManager.inst?.playSpecialBomb();
        } else if (special === SpecialType.COLOR_BOMB) {
            AudioManager.inst?.playSpecialColorBomb();
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  下落补位
    // ══════════════════════════════════════════════════════════════════════════

    private async applyGravity(): Promise<void> {
        const { ROWS, COLS, TILE_SIZE, GAP } = Board;
        const promises: Promise<void>[] = [];
        let anyFell = false;

        for (let c = 0; c < COLS; c++) {
            const survivors: { colorId: number; node: Node; special: SpecialType }[] = [];
            for (let r = ROWS - 1; r >= 0; r--) {
                // B4 修复: 加 isValid 检查，跳过已销毁/失效节点
                const node = this.tiles[r]?.[c];
                if (this.grid[r][c] >= 0 && node && node.isValid) {
                    survivors.push({ colorId: this.grid[r][c], node, special: this.tileSpecials[r][c] });
                    this.grid[r][c] = -1;
                    this.tiles[r][c] = null;
                    this.tileSpecials[r][c] = SpecialType.NONE;
                } else {
                    // B4 修复: 清理残留的悬空引用
                    this.grid[r][c] = -1;
                    this.tiles[r][c] = null;
                    this.tileSpecials[r][c] = SpecialType.NONE;
                }
            }

            for (let i = 0; i < survivors.length; i++) {
                const targetRow = ROWS - 1 - i;
                const { colorId, node, special } = survivors[i];
                // B4 修复: 二次确认节点有效
                if (!node || !node.isValid) continue;
                this.grid[targetRow][c] = colorId;
                this.tiles[targetRow][c] = node;
                this.tileSpecials[targetRow][c] = special;
                this.tileInfoMap.set(node, { row: targetRow, col: c });
                node.name = `Tile_${targetRow}_${c}`;
                const gs = node.getComponent(TileGesture);
                if (gs) { gs.row = targetRow; gs.col = c; }

                const targetPos = this.tileToLocalPosition(targetRow, c);
                const currentPos = node.getPosition();
                const dy = Math.abs(currentPos.y - targetPos.y);
                if (dy > 0.5) {
                    anyFell = true;
                    // C1: 下落时长 = 0.15 × √(格数)，easing: quadIn 带落地感
                    const cells = dy / (TILE_SIZE + GAP);
                    const dur = Math.max(0.05, Board.FALL_BASE_DURATION * Math.sqrt(Math.max(1, cells)));
                    const colDelay = c * Board.COLUMN_DELAY;
                    promises.push(this.tweenPromise(node, dur, { position: targetPos }, 'quadIn', colDelay));
                }
            }

            const newCount = ROWS - survivors.length;
            for (let i = 0; i < newCount; i++) {
                const targetRow = i;
                const colorId = Math.floor(Math.random() * this.colorCount);
                const tileNode = this.createTileNode(targetRow, c, colorId);

                const startRow = targetRow - newCount;
                tileNode.setPosition(this.tileToLocalPosition(startRow, c));

                this.grid[targetRow][c] = colorId;
                this.tiles[targetRow][c] = tileNode;
                this.tileSpecials[targetRow][c] = SpecialType.NONE;
                this.tileInfoMap.set(tileNode, { row: targetRow, col: c });

                const targetPos = this.tileToLocalPosition(targetRow, c);
                const dy = Math.abs(tileNode.getPosition().y - targetPos.y);
                const cells = dy / (TILE_SIZE + GAP);
                const dur = Math.max(0.05, Board.FALL_BASE_DURATION * Math.sqrt(Math.max(1, cells)));
                const colDelay = c * Board.COLUMN_DELAY;
                promises.push(this.tweenPromise(tileNode, dur, { position: targetPos }, 'quadIn', colDelay));
            }
        }

        // C2: 确保特效层在方块之上（新方块可能加在了特效层后面）
        this.ensureEffectsLayer();

        if (anyFell) {
            AudioManager.inst?.playFall();
        }
        await Promise.all(promises);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  工具方法
    // ══════════════════════════════════════════════════════════════════════════

    private tweenPromise(target: object, duration: number, props: object, easing?: string, delaySec?: number): Promise<void> {
        return new Promise<void>(resolve => {
            const t = tween(target);
            if (delaySec && delaySec > 0) t.delay(delaySec);
            if (easing) {
                t.to(duration, props, { easing });
            } else {
                t.to(duration, props);
            }
            t.call(() => resolve()).start();
        });
    }

    /** C2: 获取/创建特效层（COMBO/引导/洗牌提示挂这层，确保在方块之上） */
    private ensureEffectsLayer(): Node {
        if (!this._effectsLayer || !this._effectsLayer.isValid) {
            this._effectsLayer = new Node('EffectsLayer');
            this._effectsLayer.parent = this.node;
            const ut = this._effectsLayer.addComponent(UITransform);
            const boardUT = this.node.getComponent(UITransform);
            if (boardUT) ut.setContentSize(boardUT.width, boardUT.height);
        }
        // 始终移到最后（确保在所有方块之上）
        this._effectsLayer.setSiblingIndex(this.node.children.length - 1);
        return this._effectsLayer;
    }

    /** 延时工具（用于无效交换回弹前的停顿） */
    private delay(seconds: number): Promise<void> {
        return new Promise(resolve => {
            this.scheduleOnce(() => resolve(), seconds);
        });
    }

    /** 轻震屏：对棋盘根节点做小幅抖动（±intensity px、0.125s 快速回位） */
    private shakeBoard(intensity: number): void {
        const origPos = this.node.getPosition();
        const ox = origPos.x;
        const oy = origPos.y;
        Tween.stopAllByTarget(this.node);
        tween(this.node)
            .to(0.025, { position: new Vec3(ox + intensity, oy, 0) })
            .to(0.025, { position: new Vec3(ox - intensity, oy, 0) })
            .to(0.025, { position: new Vec3(ox, oy + intensity, 0) })
            .to(0.025, { position: new Vec3(ox, oy - intensity * 0.5, 0) })
            .to(0.025, { position: origPos })
            .start();
    }

    /** C2 补丁: COMBO 弹字 — 高对比亮橙 + 深紫描边 + 投影 + 加大加粗 + 冲击弹入 */
    private showComboLabel(chainCount: number, matches: Array<{ row: number; col: number }>): void {
        // 计算消除中心
        let sumX = 0, sumY = 0, cnt = 0;
        for (const { row, col } of matches) {
            const pos = this.tileToLocalPosition(row, col);
            sumX += pos.x;
            sumY += pos.y;
            cnt++;
        }
        if (cnt === 0) return;
        const cx = sumX / cnt;
        const cy = sumY / cnt;
        // NaN 护栏
        if (!isFinite(cx) || !isFinite(cy)) return;

        const comboNode = new Node('Combo');
        comboNode.parent = this.ensureEffectsLayer();
        comboNode.setPosition(cx, cy, 0);

        const comboUT = comboNode.addComponent(UITransform);
        comboUT.setContentSize(300, 80);

        const comboLabel = comboNode.addComponent(Label);
        comboLabel.string = `COMBO x${chainCount}`;
        comboLabel.fontSize = 48;               // 加大：38→48
        comboLabel.lineHeight = 54;
        comboLabel.isBold = true;                // 加粗
        comboLabel.color = new Color(0xFF, 0x7A, 0x00);  // 高饱和亮橙 #FF7A00
        comboLabel.useSystemFont = true;
        comboLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        comboLabel.verticalAlign = Label.VerticalAlign.CENTER;
        comboLabel.overflow = Label.Overflow.NONE;

        // 深紫描边 #4A2B6B width 4
        comboLabel.enableOutline = true;
        comboLabel.outlineColor = new Color(0x4A, 0x2B, 0x6B, 255);
        comboLabel.outlineWidth = 4;

        // 投影：向下偏移 3px + 半透明黑 + 模糊 4
        comboLabel.enableShadow = true;
        comboLabel.shadowColor = new Color(0, 0, 0, 160);
        comboLabel.shadowOffset = new Vec2(0, -3);
        comboLabel.shadowBlur = 4;

        const opacity = comboNode.addComponent(UIOpacity);
        comboNode.setScale(0, 0, 1);  // 从 0 开始冲击

        // C2 补丁: scale 0→1.2→1.0 冲击弹入 (backOut) + 短暂停留 + 上浮 + 淡出
        tween(comboNode)
            .to(0.18, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'backOut' })
            .to(0.08, { scale: new Vec3(1.0, 1.0, 1) })
            .delay(0.15)  // 短暂停留
            .by(0.5, { position: new Vec3(0, 50, 0) })  // 上浮 50px
            .start();

        // 淡出 + 销毁
        tween(opacity)
            .delay(0.35)
            .to(0.3, { opacity: 0 })
            .call(() => {
                comboNode.destroy();
            })
            .start();
    }
}
