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

/** T4a: 视觉波纹种子（仅供表现层使用） */
interface VisualWaveSeed {
    row: number;
    col: number;
    special: SpecialType;
    baseDelay: number;
}

/** T4a: 特效交换结果（内部返回结构） */
interface SpecialExchangeResult {
    cells: Set<string>;
    waveSeeds: VisualWaveSeed[];
    isFullBoardClear: boolean;
}

/** T5: expandSpecialSplash 返回结构 */
interface SplashResult {
    delayMap: Map<string, number>;
    waveStyleMap: Map<string, 'normal' | 'color' | 'full'>;
}

/** U1: 冰层障碍配置（单格） */
export interface IceCellConfig {
    row: number;
    col: number;
    layers: number;  // 1=单层冰, 2=双层冰
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
    /** U1: 冰层被击破一层（layersRemaining > 0 表示仍有残余） */
    onIceDamaged?: (row: number, col: number, layersRemaining: number) => void;
    /** U1: 冰层完全清除（某一格的冰层归零） */
    onIceCleared?: (row: number, col: number) => void;
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
    // T4a/T5: 视觉波纹常量（只控制表现，不参与逻辑计算）
    static readonly WAVE_LINE_STEP = 0.035;        // 线消：35ms/格
    static readonly WAVE_BOMB_STEP = 0.045;        // 炸弹：45ms/圈
    static readonly WAVE_DEFAULT_MAX_DELAY = 0.4;  // 线消/炸弹最大视觉启动延迟
    static readonly WAVE_COLOR_STEP = 0.07;        // 彩球清色：70ms/距离层
    static readonly WAVE_COLOR_MAX_DELAY = 0.85;   // 彩球清色最大启动延迟
    static readonly WAVE_FULL_CLEAR_STEP = 0.075;  // 全屏清除：75ms/距离层
    static readonly WAVE_FULL_CLEAR_MAX_DELAY = 1.1; // 全屏清除最大启动延迟
    static readonly WAVE_HARD_MAX_DELAY = 1.1;     // 绝对硬上限

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

    // ── U1: 冰层障碍 ──────────────────────────
    /** 冰层数据矩阵：0=无冰, 1=单层, 2=双层 */
    private iceLayers: number[][] = [];
    /** 冰层视觉节点矩阵（与 iceLayers 对应，null=无节点） */
    private iceNodes: Array<Array<Node | null>> = [];
    /** 冰层专用渲染层（在方块之上、特效层之下） */
    private _obstacleLayer: Node | null = null;
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
    /** U1: 加载期间暂存的冰层配置 */
    private pendingIceConfig: IceCellConfig[] | null = null;

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
    // T1: 待执行的顿帧时长（特效引爆时设置，在 async 链中 await）
    private _pendingHitstop: number = 0;

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
            const ice = this.pendingIceConfig;
            this.pendingColorCount = null;
            this.pendingIceConfig = null;
            this.resetBoard(cc, ice ?? []);
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
    public resetBoard(colorCount: number, iceConfig: IceCellConfig[] = []): void {
        // 头像未加载完时暂存请求
        if (!this.framesReady) {
            this.pendingColorCount = colorCount;
            this.pendingIceConfig = iceConfig.length > 0 ? iceConfig : null;
            return;
        }

        // U1: 规范化冰层配置
        const safeIce = this.normalizeIceConfig(iceConfig);

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

        // U1: 清理旧冰层视觉
        this.clearIceVisuals();

        this.grid = [];
        this.tiles = [];
        this.tileSpecials = [];
        this.tileInfoMap.clear();
        this.selectedTile = null;
        this._activatedSpecials.clear();  // B3 修复: 重置已激活集合
        this._pendingHitstop = 0;         // T1: 重置顿帧
        this.stopGuideAnimation();   // C0: 停止引导
        this.stopHintAnimation();    // 停止提示
        if (this._effectsLayer && this._effectsLayer.isValid) {
            this._effectsLayer.removeAllChildren();
        }
        this.setState(BoardState.IDLE);
        this.totalScore = 0;
        this.colorCount = Math.min(colorCount, Board.COLORS.length);

        // U1: 初始化冰层数据矩阵（在 generateBoard 之前设置，供其读取）
        this._pendingIceInit = safeIce;

        this.generateBoard();
    }

    /** U1: 暂存的冰层初始化配置（generateBoard 读取后清空） */
    private _pendingIceInit: IceCellConfig[] = [];

    /** U1: 规范化冰层配置 — 去重、越界裁剪、layers 范围限制 */
    private normalizeIceConfig(raw: IceCellConfig[]): IceCellConfig[] {
        if (!raw || raw.length === 0) return [];
        const seen = new Set<string>();
        const result: IceCellConfig[] = [];
        for (const item of raw) {
            const r = Math.floor(item.row);
            const c = Math.floor(item.col);
            if (r < 0 || r >= Board.ROWS || c < 0 || c >= Board.COLS) continue;
            const layers = Math.max(1, Math.min(2, Math.floor(item.layers)));
            const key = `${r},${c}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({ row: r, col: c, layers });
        }
        return result;
    }

    /** U1: 清理所有冰层视觉节点 */
    private clearIceVisuals(): void {
        if (this.iceNodes) {
            for (let r = 0; r < this.iceNodes.length; r++) {
                if (!this.iceNodes[r]) continue;
                for (let c = 0; c < this.iceNodes[r].length; c++) {
                    const node = this.iceNodes[r][c];
                    if (node && node.isValid) {
                        Tween.stopAllByTarget(node);
                        node.destroy();
                    }
                    this.iceNodes[r][c] = null;
                }
            }
        }
        this.iceLayers = [];
        this.iceNodes = [];
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
    //  U1: 冰层障碍 — 公开只读接口（供 GameManager 查询）
    // ══════════════════════════════════════════════════════════════════════════

    /** U1: 获取仍有冰层的格子数量 */
    public getRemainingIceCells(): number {
        let count = 0;
        for (let r = 0; r < Board.ROWS; r++) {
            if (!this.iceLayers[r]) continue;
            for (let c = 0; c < Board.COLS; c++) {
                if (this.iceLayers[r][c] > 0) count++;
            }
        }
        return count;
    }

    /** U1: 获取剩余冰层总层数（单层=1, 双层=2） */
    public getRemainingIceLayers(): number {
        let total = 0;
        for (let r = 0; r < Board.ROWS; r++) {
            if (!this.iceLayers[r]) continue;
            for (let c = 0; c < Board.COLS; c++) {
                total += this.iceLayers[r][c];
            }
        }
        return total;
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
            // U1: 初始化冰层数据矩阵
            this.iceLayers[r] = [];
            this.iceNodes[r] = [];
            for (let c = 0; c < COLS; c++) {
                const colorId = this.pickSafeColor(r, c);
                const tileNode = this.createTileNode(r, c, colorId);
                this.grid[r][c] = colorId;
                this.tiles[r][c] = tileNode;
                this.tileSpecials[r][c] = SpecialType.NONE;
                this.tileInfoMap.set(tileNode, { row: r, col: c });
                // U1: 默认无冰
                this.iceLayers[r][c] = 0;
                this.iceNodes[r][c] = null;
            }
        }

        // U1: 应用冰层配置（从 _pendingIceInit 读取）
        if (this._pendingIceInit && this._pendingIceInit.length > 0) {
            for (const ice of this._pendingIceInit) {
                this.iceLayers[ice.row][ice.col] = ice.layers;
            }
            this._pendingIceInit = [];  // 消费完毕
            console.log(`[Board] 🧊 冰层配置已应用: ${this.getRemainingIceCells()} 格有冰`);
        }

        // ★ A3: 开局/切关保证 — 无现成三连 && 有可行步（静默，无提示文字）
        this.ensureValidBoard();

        // C2: 创建特效层（确保在方块之上）
        this.ensureEffectsLayer();

        // U1: 创建障碍层 + 刷新冰层视觉
        this.refreshIceVisual();

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
            const specialResult = this.triggerSpecialExchange(a, b);

            if (specialResult) {
                const specialCells = specialResult.cells;
                // 特效交换被触发 → 展开 + 销毁 + 连锁
                hadMatches = true;
                const { delayMap, waveStyleMap } = this.expandSpecialSplash(
                    specialCells, specialResult.waveSeeds, specialResult.isFullBoardClear,
                );
                // T1: 顿帧——特效引爆后插入极短停顿
                if (this._pendingHitstop > 0) {
                    const hs = this._pendingHitstop;
                    this._pendingHitstop = 0;
                    await this.hitstop(hs);
                }
                await this.destroyCellSet(specialCells, delayMap, waveStyleMap);

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
    private triggerSpecialExchange(a: TileInfo, b: TileInfo): SpecialExchangeResult | null {
        const { ROWS, COLS } = Board;
        const sa = this.tileSpecials[a.row]?.[a.col] ?? SpecialType.NONE;
        const sb = this.tileSpecials[b.row]?.[b.col] ?? SpecialType.NONE;

        if (sa === SpecialType.NONE && sb === SpecialType.NONE) return null;

        const cells = new Set<string>();
        const waveSeeds: VisualWaveSeed[] = [];
        let isFullBoardClear = false;
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
                isFullBoardClear = true;
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
// T5: 彩球组合传入真实目标格 + isFullBoardClear
const specialVisualTargets = (isColor(sa) || isColor(sb)) ? cells : undefined;
this.playSpecialBurst(a.row, a.col, sa, specialVisualTargets, isFullBoardClear, true);
this.playSpecialBurst(b.row, b.col, sb, specialVisualTargets, isFullBoardClear, false);
// 移除视觉层（tile 即将被 destroyCellSet 销毁，提前清视觉避免残留闪烁）
const tileA = this.tiles[a.row]?.[a.col];
const tileB = this.tiles[b.row]?.[b.col];
if (tileA) this.removeSpecialVisual(tileA);
if (tileB) this.removeSpecialVisual(tileB);
// T4a: 保存表现种子
if (sa !== SpecialType.NONE) waveSeeds.push({ row: a.row, col: a.col, special: sa, baseDelay: 0 });
if (sb !== SpecialType.NONE) waveSeeds.push({ row: b.row, col: b.col, special: sb, baseDelay: 0 });
return { cells, waveSeeds, isFullBoardClear };
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
// T5: 传入真实目标格
this.playSpecialBurst(bombPos.row, bombPos.col, SpecialType.COLOR_BOMB, cells, false);
// 移除视觉层
const tileBomb = this.tiles[bombPos.row]?.[bombPos.col];
if (tileBomb) this.removeSpecialVisual(tileBomb);
// T4a: 保存表现种子
waveSeeds.push({ row: bombPos.row, col: bombPos.col, special: SpecialType.COLOR_BOMB, baseDelay: 0 });
return { cells, waveSeeds, isFullBoardClear: false };
        }

        // ── 一个 LINE/BOMB + 一个普通 → 走普通匹配（特效格可能被波及而被动激活）──
        return null;
    }

    /** B3/B4: 从 Set<string> 销毁所有格（动画 + 清理数据），与 eliminateMatches 逻辑一致 */
    private async destroyCellSet(
        cells: Set<string>,
        delayMap: Map<string, number> = new Map(),
        waveStyleMap: Map<string, 'normal' | 'color' | 'full'> = new Map(),
    ): Promise<void> {
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
            // U1: 对冰层造成伤害（在清 grid 之前）
            this.damageIceAt(row, col);
            this.grid[row][col] = -1;
            this.tiles[row][col] = null;
            this.tileSpecials[row][col] = SpecialType.NONE;
            this.tileInfoMap.delete(tileNode);
            destroyedCount++;

            // T4a: 延迟视觉消失动画（逻辑数据已在上文立即清理）
            const delaySec = delayMap.get(key) ?? 0;
            const ws = waveStyleMap.get(key) ?? 'normal';
            promises.push(
                this.animateEliminatedTile(tileNode, row, col, eliminatedColor, delaySec, ws),
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

    /** T4a: 共用视觉销毁动画（带延迟启动），不含计分/回调/矩阵清理 */
    private animateEliminatedTile(
        tileNode: Node,
        row: number,
        col: number,
        eliminatedColor: number,
        delaySec: number,
        waveStyle: 'normal' | 'color' | 'full' = 'normal',
    ): Promise<void> {
        let safeDelay = 0;
        if (typeof delaySec === 'number' && isFinite(delaySec) && delaySec > 0) {
            safeDelay = Math.min(delaySec, Board.WAVE_HARD_MAX_DELAY);
        }

        return new Promise<void>(resolve => {
            const startAnimation = () => {
                if (!this.isValid || !tileNode || !tileNode.isValid) {
                    resolve();
                    return;
                }
                const isColorWave = waveStyle === 'color' || waveStyle === 'full';

                // ★ H2: 在消除位置喷同色柔光粒子
                if (eliminatedColor >= 0 && eliminatedColor < Board.COLORS.length) {
                    const pos = this.tileToLocalPosition(row, col);
                    if (isFinite(pos.x) && isFinite(pos.y)) {
                        this.spawnEliminateParticles(pos.x, pos.y, Board.COLORS[eliminatedColor]);
                    }
                }

                const opacity = tileNode.getComponent(UIOpacity) ?? tileNode.addComponent(UIOpacity);

                if (isColorWave) {
                    // T5: 彩球波纹格——先亮起 + 光圈，再缩小消失（延长至 0.18s）
                    const brightTime = 0.06;
                    const vanishTime = 0.18;

                    // 1. 快速亮起
                    tween(tileNode)
                        .to(brightTime, { scale: new Vec3(1.18, 1.18, 1) }, { easing: 'quadOut' })
                        .to(vanishTime, { scale: new Vec3(0, 0, 0) }, { easing: 'quadIn' })
                        .start();

                    // 2. 产生对应颜色小光圈
                    const pos = this.tileToLocalPosition(row, col);
                    if (isFinite(pos.x) && isFinite(pos.y)) {
                        this.spawnWaveRing(pos, eliminatedColor);
                    }

                    // 3. 淡出
                    tween(opacity)
                        .delay(brightTime)
                        .to(vanishTime, { opacity: 0 })
                        .call(() => { if (tileNode.isValid) tileNode.destroy(); resolve(); })
                        .start();
                } else {
                    // 普通模式：原速度
                    tween(tileNode)
                        .to(Board.ELIMINATE_SCALE_UP, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'backOut' })
                        .to(Board.ELIMINATE_SCALE_DOWN, { scale: new Vec3(0, 0, 0) }, { easing: 'quadIn' })
                        .start();
                    tween(opacity)
                        .delay(Board.ELIMINATE_SCALE_UP)
                        .to(Board.ELIMINATE_SCALE_DOWN, { opacity: 0 })
                        .call(() => { if (tileNode.isValid) tileNode.destroy(); resolve(); })
                        .start();
                }
            };

            if (safeDelay > 0) {
                setTimeout(() => startAnimation(), safeDelay * 1000);
            } else {
                startAnimation();
            }
        });
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
        const MAX_RETRIES = 20;

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

        // U1: 冰层数据保持不变（forceRegenerate 只重置方块，不重置障碍）

        // 直接调 generateBoard（内部用 pickSafeColor 保证无三连）
        for (let r = 0; r < ROWS; r++) {
            this.grid[r] = [];
            this.tiles[r] = [];
            this.tileSpecials[r] = [];
            // U1: 确保冰层矩阵存在（forceRegenerate 不清冰）
            if (!this.iceLayers[r]) this.iceLayers[r] = [];
            if (!this.iceNodes[r]) this.iceNodes[r] = [];
            for (let c = 0; c < COLS; c++) {
                const colorId = this.pickSafeColor(r, c);
                const tileNode = this.createTileNode(r, c, colorId);
                this.grid[r][c] = colorId;
                this.tiles[r][c] = tileNode;
                this.tileSpecials[r][c] = SpecialType.NONE;
                this.tileInfoMap.set(tileNode, { row: r, col: c });
                if (this.iceLayers[r][c] === undefined) this.iceLayers[r][c] = 0;
                if (!this.iceNodes[r][c]) this.iceNodes[r][c] = null;
            }
        }
        console.log('[Board] 强制重生成完成');
        this.ensureEffectsLayer();  // C2: 确保特效层在方块之上
        this.refreshIceVisual();    // U1: 刷新冰层视觉
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
    private expandSpecialSplash(
        destroyedCells: Set<string>,
        initialSeeds: VisualWaveSeed[] = [],
        isFullBoardClear: boolean = false,
    ): SplashResult {
        const { ROWS, COLS } = Board;
        const delayMap = new Map<string, number>();
        const waveStyleMap = new Map<string, 'normal' | 'color' | 'full'>();
        let hasColorBombSeed = isFullBoardClear;

        // ── T4a/T5: 延迟计算工具 ──────────────────────
        const computeDelay = (sr: number, sc: number, special: SpecialType, baseDelay: number, r: number, c: number): number => {
            let dist = 0;
            let step = Board.WAVE_LINE_STEP;
            let maxDelay = Board.WAVE_DEFAULT_MAX_DELAY;
            if (special === SpecialType.LINE_H) {
                if (r === sr) {
                    dist = Math.abs(c - sc);
                } else {
                    dist = Math.abs(r - sr) + Math.abs(c - sc); // Manhattan fallback
                }
                step = Board.WAVE_LINE_STEP;
                maxDelay = Board.WAVE_DEFAULT_MAX_DELAY;
            } else if (special === SpecialType.LINE_V) {
                if (c === sc) {
                    dist = Math.abs(r - sr);
                } else {
                    dist = Math.abs(r - sr) + Math.abs(c - sc);
                }
                step = Board.WAVE_LINE_STEP;
                maxDelay = Board.WAVE_DEFAULT_MAX_DELAY;
            } else if (special === SpecialType.BOMB) {
                dist = Math.max(Math.abs(r - sr), Math.abs(c - sc));
                step = Board.WAVE_BOMB_STEP;
                maxDelay = Board.WAVE_DEFAULT_MAX_DELAY;
            } else if (special === SpecialType.COLOR_BOMB) {
                dist = Math.abs(r - sr) + Math.abs(c - sc);
                if (isFullBoardClear) {
                    step = Board.WAVE_FULL_CLEAR_STEP;
                    maxDelay = Board.WAVE_FULL_CLEAR_MAX_DELAY;
                } else {
                    step = Board.WAVE_COLOR_STEP;
                    maxDelay = Board.WAVE_COLOR_MAX_DELAY;
                }
            } else {
                dist = Math.abs(r - sr) + Math.abs(c - sc);
                step = Board.WAVE_LINE_STEP;
                maxDelay = Board.WAVE_DEFAULT_MAX_DELAY;
            }
            return Math.min(baseDelay + dist * step, maxDelay);
        };

        const setDelayMin = (k: string, d: number) => {
            const safeD = (typeof d === 'number' && isFinite(d) && d >= 0) ? Math.min(d, Board.WAVE_HARD_MAX_DELAY) : 0;
            const prev = delayMap.get(k);
            if (prev === undefined || safeD < prev) {
                delayMap.set(k, safeD);
            }
        };

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

        // T4a: 记录 BFS 中发现的被动特效种子
        const passiveSeeds: VisualWaveSeed[] = [];

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

            // T4a: 记录被动特效种子（baseDelay 待后填）
            passiveSeeds.push({ row: r, col: c, special, baseDelay: 0 });
            if (special === SpecialType.COLOR_BOMB) hasColorBombSeed = true;

            // 特效被引爆 → 通知 GameManager 计数
            this.callbacks.onSpecialDetonated?.();

            if (special === SpecialType.LINE_H) {
                console.log(`[Board] 💥 特效引爆: (${r},${c}) = LINE_H`);
                for (let cc = 0; cc < COLS; cc++) addCell(r, cc);
                // 激活 juice
                this.playSpecialBurst(r, c, special);
            } else if (special === SpecialType.LINE_V) {
                console.log(`[Board] 💥 特效引爆: (${r},${c}) = LINE_V`);
                for (let rr = 0; rr < ROWS; rr++) addCell(rr, c);
                // 激活 juice
                this.playSpecialBurst(r, c, special);
            } else if (special === SpecialType.BOMB) {
                // B2: 以 (r,c) 为中心 3×3
                let cnt = 0;
                for (let dr = -1; dr <= 1; dr++)
                    for (let dc = -1; dc <= 1; dc++) { addCell(r + dr, c + dc); cnt++; }
                console.log(`[B2] 炸弹激活 (${r},${c}) 清${cnt}格`);
                // 激活 juice
                this.playSpecialBurst(r, c, special);
            } else if (special === SpecialType.COLOR_BOMB) {
                // B3: 被动引爆 — 清最多色全盘 + 彩球自身
                const targetColor = this.getMostCommonColor();
                const passiveTargets = new Set<string>();
                let cnt = 0;
                for (let rr = 0; rr < ROWS; rr++)
                    for (let cc = 0; cc < COLS; cc++)
                        if (this.grid[rr] && this.grid[rr][cc] === targetColor) {
                            addCell(rr, cc);
                            passiveTargets.add(`${rr},${cc}`);
                            cnt++;
                        }
                addCell(r, c); // 彩球自身
                passiveTargets.add(`${r},${c}`);
                console.log(`[B3] 彩球激活(被动) (${r},${c}) 目标色=${targetColor} 清${cnt}格`);
                // T5: 激活 juice（传入真实目标格）
                this.playSpecialBurst(r, c, special, passiveTargets, false);
            }
        }

        // ── T4a: 计算视觉延迟 ──────────────────────
        // 注意：不要提前把所有格子初始化为 0，否则正数延迟永远无法覆盖。

        // 1. 从主动种子计算延迟（delayMap 此时为空，首次写入即为真实值）
        for (const seed of initialSeeds) {
            const seedKey = `${seed.row},${seed.col}`;
            setDelayMin(seedKey, seed.baseDelay);
            for (const key of destroyedCells) {
                const [r, c] = key.split(',').map(Number);
                if (!isFinite(r) || !isFinite(c)) continue;
                setDelayMin(key, computeDelay(seed.row, seed.col, seed.special, seed.baseDelay, r, c));
            }
        }

        // 2. 从被动种子计算延迟（baseDelay 继承该格已计算的 delay）
        for (const pseed of passiveSeeds) {
            const pseedKey = `${pseed.row},${pseed.col}`;
            const inheritedDelay = delayMap.get(pseedKey);
            pseed.baseDelay =
                typeof inheritedDelay === 'number' &&
                isFinite(inheritedDelay) &&
                inheritedDelay >= 0
                    ? inheritedDelay
                    : 0;
            setDelayMin(pseedKey, pseed.baseDelay);
            for (const key of destroyedCells) {
                const [r, c] = key.split(',').map(Number);
                if (!isFinite(r) || !isFinite(c)) continue;
                setDelayMin(key, computeDelay(pseed.row, pseed.col, pseed.special, pseed.baseDelay, r, c));
            }
        }

        // 3. 安全降级：无种子的格子（含普通匹配）降级为 0；有值但越界的 clamp 到 0～WAVE_HARD_MAX_DELAY
        for (const key of destroyedCells) {
            const delay = delayMap.get(key);
            if (typeof delay !== 'number' || !isFinite(delay) || delay < 0) {
                delayMap.set(key, 0);
            } else if (delay > Board.WAVE_HARD_MAX_DELAY) {
                delayMap.set(key, Board.WAVE_HARD_MAX_DELAY);
            }
        }

        // T5: 构建 waveStyleMap
        const ws: 'normal' | 'color' | 'full' = isFullBoardClear ? 'full' : hasColorBombSeed ? 'color' : 'normal';
        for (const key of destroyedCells) {
            waveStyleMap.set(key, ws);
        }

        // 4. 防回归诊断（仅在存在特效种子时输出）
        const seedCount = initialSeeds.length + passiveSeeds.length;
        if (seedCount > 0 && destroyedCells.size > 1) {
            const delays = Array.from(delayMap.values()).filter(
                d => typeof d === 'number' && isFinite(d),
            );
            const positiveCount = delays.filter(d => d > 0).length;
            const maxDelay = delays.length > 0 ? Math.max(...delays) : 0;
            console.log(
                `[T4a] 视觉波纹 seeds=${seedCount} cells=${destroyedCells.size} ` +
                `positive=${positiveCount} maxDelay=${maxDelay.toFixed(3)}s`,
            );
            if (positiveCount === 0) {
                console.warn('[T4a] 特效波纹没有产生正数延迟，请检查 delayMap 计算');
            }
        }

        if (processed.size > 1) {
            console.log(`[Board] 特效引爆展开完成，待消集合: ${destroyedCells.size} 格`);
        }

        return { delayMap, waveStyleMap };
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
        // T4a: 同时获取视觉延迟映射
        // T5: 同时获取 waveStyleMap
        const { delayMap, waveStyleMap } = this.expandSpecialSplash(destroyedCells);

        // T1: 顿帧——被动引爆特效后插入极短停顿
        if (this._pendingHitstop > 0) {
            const hs = this._pendingHitstop;
            this._pendingHitstop = 0;
            await this.hitstop(hs);
        }

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
            // U1: 对冰层造成伤害（在清 grid 之前）
            this.damageIceAt(row, col);
            this.grid[row][col] = -1;
            this.tiles[row][col] = null;
            this.tileSpecials[row][col] = SpecialType.NONE;
            this.tileInfoMap.delete(tileNode);

            // T4a: 延迟视觉消失动画（逻辑数据已在上文立即清理）
            const delaySec = delayMap.get(key) ?? 0;
            const ws = waveStyleMap.get(key) ?? 'normal';
            promises.push(
                this.animateEliminatedTile(tileNode, row, col, eliminatedColor, delaySec, ws),
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

    /** 激活 juice：fxOverlay 放大消失 + T3 冲击波环/光束/连线 + T3 增强粒子 + T1 闪光/震屏/顿帧 + T2 震动/音效 */
    private playSpecialBurst(
        row: number,
        col: number,
        special: SpecialType,
        visualTargets?: Set<string>,
        isFullBoardClear: boolean = false,
        isPrimaryFullClear: boolean = true,
    ): void {
        if (special === SpecialType.NONE) return;
        const pos = this.tileToLocalPosition(row, col);
        if (!isFinite(pos.x) || !isFinite(pos.y)) return;
        const effectsLayer = this.ensureEffectsLayer();
        const ts = Board.TILE_SIZE;
        const safeTs = (typeof ts === 'number' && !isNaN(ts) && isFinite(ts) && ts > 0) ? ts : 70;
        const isColorBomb = special === SpecialType.COLOR_BOMB;
        const isBomb = special === SpecialType.BOMB;
        const isLine = special === SpecialType.LINE_H || special === SpecialType.LINE_V;
        const overlayScale = isColorBomb ? 0.9 : 0.85;
        const overlaySize = safeTs * overlayScale;
        // T5.1: 区分主爆点与副爆点
        const isSecondaryFullClear = isFullBoardClear && !isPrimaryFullClear;
        const playFullGlobal = isFullBoardClear && isPrimaryFullClear;

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

        // T3: 冲击波环（线消/炸弹用单环，彩球用多重冲击波）
        if (isColorBomb) {
            if (isSecondaryFullClear) {
                // T5.1: 副爆点只使用普通单环
                this.spawnShockwaveRing(pos, special, safeTs, effectsLayer);
            } else {
                this.spawnColorBombShockwaves(pos, safeTs, effectsLayer, playFullGlobal);
            }
        } else {
            this.spawnShockwaveRing(pos, special, safeTs, effectsLayer);
        }

        // T3: 线消光束
        if (special === SpecialType.LINE_H) {
            this.spawnLineBeam(row, col, true, effectsLayer);
        } else if (special === SpecialType.LINE_V) {
            this.spawnLineBeam(row, col, false, effectsLayer);
        }

        // T3: 彩球连线（T5.1: 只由主爆点生成全盘连线）
        if (isColorBomb && !isSecondaryFullClear) {
            this.spawnColorBombRays(row, col, pos, effectsLayer, visualTargets, isFullBoardClear);
        }

        // 2. T3/T5 增强粒子爆发
        // T5: 彩球加量——普通 24颗/0.85s，全屏 33颗两批/1.1s
        // T5.1: 副爆点只生成局部 14颗粒子
        const particleCount = isSecondaryFullClear ? 14 : isFullBoardClear ? 33 : isColorBomb ? 24 : isBomb ? 14 : 12;
        const particleColors: Color[] = isColorBomb
            ? Board.COLORS.map(c => c.clone())
            : isBomb
                ? [new Color(0xFF, 0xA5, 0x00), new Color(0xFF, 0xD7, 0x00), new Color(0xFF, 0x8C, 0x00)]
                : [new Color(255, 255, 255)];
        const particleDist = isColorBomb ? (isSecondaryFullClear ? 60 : 95) : 60;
        const particleLife = isColorBomb ? (isSecondaryFullClear ? 0.45 : 0.85) : 0.45;
        const batchDelay = (playFullGlobal) ? 0.2 : 0;
        for (let i = 0; i < particleCount; i++) {
            const p = new Node('particle');
            p.parent = effectsLayer;
            p.setPosition(pos);
            const pSize = 14 + Math.random() * 6;
            const pUT = p.addComponent(UITransform);
            pUT.setAnchorPoint(0.5, 0.5);
            pUT.setContentSize(pSize, pSize);
            const pG = p.addComponent(Graphics);
            const pc = particleColors[Math.floor(Math.random() * particleColors.length)];
            pG.fillColor = new Color(pc.r, pc.g, pc.b, 230);
            pG.circle(0, 0, pSize / 2);
            pG.fill();
            p.setScale(0.8, 0.8, 1);
            const angle = (i / particleCount) * Math.PI * 2 + Math.random() * 0.3;
            const dist = particleDist + Math.random() * 30;
            const dx = Math.cos(angle) * dist;
            const dy = Math.sin(angle) * dist;
            const pOp = p.addComponent(UIOpacity);
            pOp.opacity = 255;
            // T5: 全屏清除分两批，第二批延迟 0.2s（T5.1: 仅主爆点分批）
            const thisDelay = (playFullGlobal && i >= Math.floor(particleCount / 2)) ? batchDelay : 0;
            tween(p)
                .delay(thisDelay)
                .to(particleLife, { position: new Vec3(pos.x + dx, pos.y + dy, 0) }, { easing: 'quadOut' })
                .start();
            // T5.1: 修复粒子提前销毁——延迟 0.6×life + 缩小 0.4×life = 总 life
            tween(p)
                .delay(thisDelay + particleLife * 0.6)
                .to(particleLife * 0.4, { scale: new Vec3(0, 0, 1) })
                .call(() => { if (p.isValid) p.destroy(); })
                .start();
            tween(pOp)
                .delay(thisDelay)
                .to(particleLife, { opacity: 0 })
                .start();
        }

        // T1: 冲击闪光（T5.1: 副爆点不执行全屏闪光）
        if (isLine) this.impactFlash('line');
        else if (isBomb) this.impactFlash('bomb');
        else if (isColorBomb && !isSecondaryFullClear) this.impactFlash('color', playFullGlobal);

        // T5: 全屏清除稀有提示（T5.1: 只由主爆点创建一次）
        if (playFullGlobal) {
            this.spawnFullClearLabel();
        }

        // T1: 强震屏（按类型分级）（T5.1: 副爆点不重复全局强震）
        if (isColorBomb && !isSecondaryFullClear) this.shakeBoard(20);
        else if (isBomb) this.shakeBoard(14);
        else if (isLine) this.shakeBoard(8);

        // T1: 顿帧时长存入 _pendingHitstop（取最大值，async 链中 await）
        if (isColorBomb && !isSecondaryFullClear) this._pendingHitstop = Math.max(this._pendingHitstop, 150);
        else if (isBomb) this._pendingHitstop = Math.max(this._pendingHitstop, 110);
        else if (isLine) this._pendingHitstop = Math.max(this._pendingHitstop, 60);

        // T2: 震动力度分层（线消/炸弹→heavy、彩球→long）（T5.1: 副爆点不重复 long 震动）
        if (isColorBomb && !isSecondaryFullClear) VibrateManager.inst?.long();
        else if (isBomb || isLine) VibrateManager.inst?.heavy();

        // 4. 音效（T2: AudioManager 内部已做差异化降级+音量加成）
        // T5.1: 彩球+彩球副爆点不重复播放音效
        if (isLine) AudioManager.inst?.playSpecialLine();
        else if (isBomb) AudioManager.inst?.playSpecialBomb();
        else if (isColorBomb && !isSecondaryFullClear) AudioManager.inst?.playSpecialColorBomb();
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
        // U1: 确保障碍层在方块之上、特效层之下
        this.ensureObstacleLayer();

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

    // ══════════════════════════════════════════════════════════════════════════
    //  U1: 冰层障碍 — 视觉层管理
    // ══════════════════════════════════════════════════════════════════════════

    /** U1: 获取/创建障碍层（在方块之上、特效层之下） */
    private ensureObstacleLayer(): Node {
        if (!this._obstacleLayer || !this._obstacleLayer.isValid) {
            this._obstacleLayer = new Node('ObstacleLayer');
            this._obstacleLayer.parent = this.node;
            const ut = this._obstacleLayer.addComponent(UITransform);
            const boardUT = this.node.getComponent(UITransform);
            if (boardUT) ut.setContentSize(boardUT.width, boardUT.height);
        }
        // 确保 obstacleLayer 在 effectsLayer 之下（两者都存在时 obstacle 在前）
        const effectsIdx = this._effectsLayer ? this._effectsLayer.getSiblingIndex() : this.node.children.length;
        this._obstacleLayer.setSiblingIndex(Math.max(0, effectsIdx - 1));
        return this._obstacleLayer;
    }

    /** U1: 根据 iceLayers 数据刷新全部冰层视觉节点 */
    private refreshIceVisual(): void {
        if (!this.iceLayers || this.iceLayers.length === 0) return;
        const layer = this.ensureObstacleLayer();

        for (let r = 0; r < Board.ROWS; r++) {
            if (!this.iceLayers[r]) continue;
            for (let c = 0; c < Board.COLS; c++) {
                const layers = this.iceLayers[r][c];
                const existing = this.iceNodes[r]?.[c] ?? null;

                if (layers <= 0) {
                    // 无冰 → 销毁旧节点
                    if (existing && existing.isValid) {
                        Tween.stopAllByTarget(existing);
                        existing.destroy();
                    }
                    if (this.iceNodes[r]) this.iceNodes[r][c] = null;
                } else {
                    // 有冰 → 创建/更新视觉
                    if (!existing || !existing.isValid) {
                        const node = this.createIceNode(r, c, layers);
                        node.parent = layer;
                        if (!this.iceNodes[r]) this.iceNodes[r] = [];
                        this.iceNodes[r][c] = node;
                    } else {
                        // 更新现有节点（层数可能变化）
                        this.drawIceNode(existing, layers);
                    }
                }
            }
        }
    }

    /** U1: 创建冰层视觉节点 */
    private createIceNode(row: number, col: number, layers: number): Node {
        const node = new Node(`Ice_${row}_${col}`);
        const pos = this.tileToLocalPosition(row, col);
        node.setPosition(pos);

        const ut = node.addComponent(UITransform);
        ut.setContentSize(Board.TILE_SIZE, Board.TILE_SIZE);

        this.drawIceNode(node, layers);
        return node;
    }

    /** U1: 在节点上绘制冰层图形（layers=1 单层, layers=2 双层） */
    private drawIceNode(node: Node, layers: number): void {
        let g = node.getComponent(Graphics);
        if (!g) g = node.addComponent(Graphics);
        g.clear();

        const ts = Board.TILE_SIZE;
        const half = ts / 2;

        // 底层冰面：淡蓝色半透明圆角矩形
        g.fillColor = new Color(0xB0, 0xE0, 0xF0, 100);
        g.roundRect(-half, -half, ts, ts, 8);
        g.fill();

        // 冰面高光线条（模拟冰晶反光）
        g.strokeColor = new Color(0xE0, 0xF0, 0xFF, 160);
        g.lineWidth = 2;
        g.moveTo(-half + 8, half - 8);
        g.lineTo(-half + 20, half - 20);
        g.moveTo(half - 8, half - 8);
        g.lineTo(half - 20, half - 20);
        g.moveTo(-half + 8, -half + 8);
        g.lineTo(-half + 16, -half + 16);
        g.stroke();

        if (layers >= 2) {
            // 双层冰：叠加更深的蓝色 + 额外冰晶纹
            g.fillColor = new Color(0x80, 0xC0, 0xE0, 80);
            g.roundRect(-half + 4, -half + 4, ts - 8, ts - 8, 6);
            g.fill();

            // 双层标记：对角斜线纹
            g.strokeColor = new Color(0xC0, 0xE0, 0xFF, 120);
            g.lineWidth = 1.5;
            for (let i = -half + 10; i < half; i += 12) {
                g.moveTo(i, -half + 2);
                g.lineTo(i + 10, -half + 12);
            }
            g.stroke();
        }
    }

    /** U1: 对指定格的冰层造成 1 点伤害（唯一入口） */
    private damageIceAt(row: number, col: number): void {
        // 边界检查
        if (row < 0 || row >= Board.ROWS || col < 0 || col >= Board.COLS) return;
        if (!this.iceLayers[row]) return;
        const current = this.iceLayers[row][col];
        if (current <= 0) return;  // 无冰可打

        // 扣 1 层
        const remaining = current - 1;
        this.iceLayers[row][col] = remaining;

        // 视觉效果
        this.playIceHitEffect(row, col, remaining <= 0);

        if (remaining <= 0) {
            // 冰层完全清除
            this.callbacks.onIceCleared?.(row, col);
            console.log(`[Board] 🧊 冰层清除 (${row},${col})`);

            // 延迟销毁视觉节点（等动画播完）
            const node = this.iceNodes[row]?.[col] ?? null;
            if (node && node.isValid) {
                this.scheduleOnce(() => {
                    if (node && node.isValid) {
                        Tween.stopAllByTarget(node);
                        node.destroy();
                    }
                    if (this.iceNodes[row]) this.iceNodes[row][col] = null;
                }, 0.35);
            }
        } else {
            // 仍有残余冰层 → 更新视觉
            const node = this.iceNodes[row]?.[col] ?? null;
            if (node && node.isValid) {
                this.drawIceNode(node, remaining);
            }
            this.callbacks.onIceDamaged?.(row, col, remaining);
            console.log(`[Board] 🧊 冰层受损 (${row},${col}) → 剩余 ${remaining} 层`);
        }
    }

    /** U1: 冰层被击中/清除时的视觉特效 */
    private playIceHitEffect(row: number, col: number, isCleared: boolean): void {
        const layer = this.ensureEffectsLayer();
        const pos = this.tileToLocalPosition(row, col);

        // 冰屑粒子
        const shardNode = new Node('IceShard');
        shardNode.parent = layer;
        shardNode.setPosition(pos);

        const shardCount = isCleared ? 8 : 4;
        const shardColors = [
            new Color(0xE0, 0xF0, 0xFF, 220),
            new Color(0xB0, 0xD0, 0xF0, 200),
            new Color(0xC0, 0xE0, 0xFF, 180),
        ];

        for (let i = 0; i < shardCount; i++) {
            const angle = (Math.PI * 2 * i) / shardCount + Math.random() * 0.3;
            const dist = isCleared ? 30 + Math.random() * 20 : 15 + Math.random() * 10;
            const dx = Math.cos(angle) * dist;
            const dy = Math.sin(angle) * dist;
            const size = 4 + Math.random() * 4;

            const shard = new Node(`shard${i}`);
            shard.parent = shardNode;
            shard.setPosition(0, 0, 0);

            const ut = shard.addComponent(UITransform);
            ut.setContentSize(size, size);

            const g = shard.addComponent(Graphics);
            g.fillColor = shardColors[i % shardColors.length];
            g.rect(-size / 2, -size / 2, size, size);
            g.fill();

            const op = shard.addComponent(UIOpacity);
            op.opacity = 220;

            tween(shard)
                .to(0.3, { position: new Vec3(dx, dy, 0) }, { easing: 'quadOut' })
                .start();
            tween(op)
                .delay(0.15)
                .to(0.15, { opacity: 0 })
                .start();
        }

        // 清除时额外播放波纹
        if (isCleared) {
            const ringNode = new Node('IceClearRing');
            ringNode.parent = layer;
            ringNode.setPosition(pos);

            const ut = ringNode.addComponent(UITransform);
            ut.setContentSize(Board.TILE_SIZE, Board.TILE_SIZE);

            const g = ringNode.addComponent(Graphics);
            g.strokeColor = new Color(0xE0, 0xF0, 0xFF, 200);
            g.lineWidth = 3;
            g.circle(0, 0, Board.TILE_SIZE * 0.3);
            g.stroke();

            const op = ringNode.addComponent(UIOpacity);
            op.opacity = 220;

            tween(ringNode)
                .to(0.35, { scale: new Vec3(1.8, 1.8, 1) }, { easing: 'quadOut' })
                .start();
            tween(op)
                .to(0.35, { opacity: 0 })
                .call(() => ringNode.destroy())
                .start();
        }

        // 延迟清理 shard 容器
        this.scheduleOnce(() => {
            if (shardNode && shardNode.isValid) shardNode.destroy();
        }, 0.5);
    }

    /** 延时工具（用于无效交换回弹前的停顿） */
    private delay(seconds: number): Promise<void> {
        return new Promise(resolve => {
            this.scheduleOnce(() => resolve(), seconds);
        });
    }

    /** T1: 强震屏 — 位移峰值≈intensity*1.2px（上限24）、±1.5°旋转抖、0.28s 多次衰减回位 */
    private shakeBoard(intensity: number): void {
        const safeI = (typeof intensity === 'number' && isFinite(intensity) && intensity > 0) ? intensity : 4;
        const peak = Math.min(safeI * 1.2, 24);
        const origPos = this.node.getPosition();
        const ox = origPos.x;
        const oy = origPos.y;
        const rot = 1.5; // ±1.5° 旋转抖
        Tween.stopAllByTarget(this.node);
        // 6 步衰减抖动 0.28s：大幅→中→小→归位
        tween(this.node)
            .to(0.04, { position: new Vec3(ox + peak, oy + peak * 0.3, 0), angle: rot })
            .to(0.04, { position: new Vec3(ox - peak * 0.8, oy - peak * 0.5, 0), angle: -rot })
            .to(0.04, { position: new Vec3(ox + peak * 0.5, oy - peak * 0.3, 0), angle: rot * 0.5 })
            .to(0.04, { position: new Vec3(ox - peak * 0.3, oy + peak * 0.2, 0), angle: -rot * 0.3 })
            .to(0.04, { position: new Vec3(ox + peak * 0.12, oy - peak * 0.08, 0), angle: 0 })
            .to(0.08, { position: origPos, angle: 0 }) // 严格归位防漂移
            .start();
    }

    /** T1: 顿帧 — 特效引爆瞬间插入极短停顿制造打击感（硬顶 180ms） */
    private hitstop(ms: number): Promise<void> {
        const safeMs = (typeof ms === 'number' && isFinite(ms) && ms > 0) ? Math.min(ms, 180) : 0;
        if (safeMs <= 0) return Promise.resolve();
        return new Promise<void>(resolve => {
            setTimeout(() => resolve(), safeMs);
        });
    }

    /** T1: 冲击闪光 — 线消=细亮带、炸弹=白全屏闪、彩球=彩色全屏闪 */
    private impactFlash(type: 'line' | 'bomb' | 'color', isFullBoardClear: boolean = false): void {
        try {
            const layer = this.ensureEffectsLayer();
            const boardUT = this.node.getComponent(UITransform);
            const fw = (boardUT && isFinite(boardUT.width) && boardUT.width > 0) ? boardUT.width : 600;
            const fh = (boardUT && isFinite(boardUT.height) && boardUT.height > 0) ? boardUT.height : 600;
            const flashNode = new Node(`ImpactFlash_${type}`);
            flashNode.parent = layer;
            flashNode.setPosition(0, 0, 0);
            const ut = flashNode.addComponent(UITransform);
            const g = flashNode.addComponent(Graphics);
            const op = flashNode.addComponent(UIOpacity);
            op.opacity = 0;

            if (type === 'line') {
                const bandH = fh * 0.08;
                ut.setContentSize(fw, bandH);
                g.fillColor = new Color(255, 255, 255, 80);
                g.rect(-fw / 2, -bandH / 2, fw, bandH);
                g.fill();
                tween(op)
                    .to(0.03, { opacity: 255 })
                    .to(0.12, { opacity: 0 })
                    .call(() => { if (flashNode.isValid) flashNode.destroy(); })
                    .start();
            } else if (type === 'bomb') {
                ut.setContentSize(fw, fh);
                g.fillColor = new Color(255, 255, 255, 90);
                g.rect(-fw / 2, -fh / 2, fw, fh);
                g.fill();
                tween(op)
                    .to(0.03, { opacity: 255 })
                    .to(0.14, { opacity: 0 })
                    .call(() => { if (flashNode.isValid) flashNode.destroy(); })
                    .start();
            } else {
                // T5: 彩球闪光延长——0.05s亮起 + 0.15s缓降 + 0.35s柔淡 ≈ 0.55s
                ut.setContentSize(fw, fh);
                g.fillColor = new Color(0xFF, 0xB3, 0x00, 120);
                g.rect(-fw / 2, -fh / 2, fw, fh);
                g.fill();
                tween(op)
                    .to(0.05, { opacity: 255 })
                    .to(0.15, { opacity: 180 })
                    .to(0.35, { opacity: 0 })
                    .call(() => { if (flashNode.isValid) flashNode.destroy(); })
                    .start();

                // T5: 全屏清除补一次更淡的彩色回闪
                if (isFullBoardClear) {
                    const flash2 = new Node('ImpactFlash_color2');
                    flash2.parent = layer;
                    flash2.setPosition(0, 0, 0);
                    const ut2 = flash2.addComponent(UITransform);
                    ut2.setContentSize(fw, fh);
                    const g2 = flash2.addComponent(Graphics);
                    g2.fillColor = new Color(0xB5, 0x83, 0xE0, 60);
                    g2.rect(-fw / 2, -fh / 2, fw, fh);
                    g2.fill();
                    const op2 = flash2.addComponent(UIOpacity);
                    op2.opacity = 0;
                    tween(op2)
                        .delay(0.2)
                        .to(0.08, { opacity: 200 })
                        .to(0.47, { opacity: 0 })
                        .call(() => { if (flash2.isValid) flash2.destroy(); })
                        .start();
                }
            }
        } catch (e) { /* ignore */ }
    }

    /** T3: 冲击波环 — 描边圆环从~10px 扩到~1.6 格，0.35s quadOut 淡出 */
    private spawnShockwaveRing(pos: Vec3, special: SpecialType, ts: number, layer: Node): void {
        try {
            const isColor = special === SpecialType.COLOR_BOMB;
            const isBomb = special === SpecialType.BOMB;
            const maxR = isColor ? ts * 1.8 : isBomb ? ts * 1.6 : ts * 1.4;
            const safeMaxR = (isFinite(maxR) && maxR > 0) ? maxR : ts * 1.4;
            const ringNode = new Node('ShockwaveRing');
            ringNode.parent = layer;
            ringNode.setPosition(pos);
            const ut = ringNode.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            ut.setContentSize(safeMaxR * 2, safeMaxR * 2);
            const g = ringNode.addComponent(Graphics);
            g.strokeColor = isColor
                ? new Color(0xFF, 0xB3, 0x00, 220)
                : isBomb
                    ? new Color(255, 200, 100, 220)
                    : new Color(255, 255, 255, 220);
            g.lineWidth = 6;
            g.circle(0, 0, safeMaxR);
            g.stroke();
            const op = ringNode.addComponent(UIOpacity);
            op.opacity = 220;
            // 从小scale扩到大scale
            const startScale = 10 / safeMaxR;
            ringNode.setScale(startScale, startScale, 1);
            tween(ringNode)
                .to(0.35, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' })
                .start();
            tween(op)
                .to(0.35, { opacity: 0 })
                .call(() => { if (ringNode.isValid) ringNode.destroy(); })
                .start();
        } catch (e) { /* ignore */ }
    }

    /** T5: 彩球专属多重冲击波 — 3 层环逐层扩散，粉/金/淡紫
     *  T5.1: playFullGlobal 控制全屏主爆点时第三环半径略增 */
    private spawnColorBombShockwaves(pos: Vec3, ts: number, layer: Node, playFullGlobal: boolean): void {
        try {
            const ring3MaxR = playFullGlobal ? ts * 2.8 : ts * 2.4;
            const rings = [
                { delay: 0,    duration: 0.65, maxR: ts * 1.6, color: new Color(0xFF, 0xB3, 0xCC, 180), lw: 5 },
                { delay: 0.16, duration: 0.70, maxR: ts * 2.0, color: new Color(0xFF, 0xD7, 0x00, 150), lw: 4 },
                { delay: 0.32, duration: 0.75, maxR: ring3MaxR, color: new Color(0xB5, 0x83, 0xE0, 130), lw: 4 },
            ];
            for (const ring of rings) {
                const safeMaxR = (isFinite(ring.maxR) && ring.maxR > 0) ? ring.maxR : ts * 1.6;
                const ringNode = new Node('ColorBombShockwave');
                ringNode.parent = layer;
                ringNode.setPosition(pos);
                const ut = ringNode.addComponent(UITransform);
                ut.setAnchorPoint(0.5, 0.5);
                ut.setContentSize(safeMaxR * 2, safeMaxR * 2);
                const g = ringNode.addComponent(Graphics);
                g.strokeColor = ring.color.clone();
                g.lineWidth = ring.lw;
                g.circle(0, 0, safeMaxR);
                g.stroke();
                const op = ringNode.addComponent(UIOpacity);
                op.opacity = 0;
                const startScale = 10 / safeMaxR;
                ringNode.setScale(startScale, startScale, 1);
                tween(ringNode)
                    .delay(ring.delay)
                    .to(ring.duration, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' })
                    .start();
                tween(op)
                    .delay(ring.delay)
                    .to(0.05, { opacity: 220 })
                    .to(ring.duration - 0.05, { opacity: 0 })
                    .call(() => { if (ringNode.isValid) ringNode.destroy(); })
                    .start();
            }
        } catch (e) { /* ignore */ }
    }

    /** T5: 彩球波纹格光圈 — 格子消失时产生对应颜色小光圈 */
    private spawnWaveRing(pos: Vec3, colorId: number): void {
        try {
            const layer = this.ensureEffectsLayer();
            const ringNode = new Node('WaveRing');
            ringNode.parent = layer;
            ringNode.setPosition(pos);
            const ut = ringNode.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            const maxR = Board.TILE_SIZE * 0.9;
            ut.setContentSize(maxR * 2, maxR * 2);
            const g = ringNode.addComponent(Graphics);
            const color = (colorId >= 0 && colorId < Board.COLORS.length)
                ? Board.COLORS[colorId]
                : new Color(255, 255, 255);
            g.strokeColor = new Color(color.r, color.g, color.b, 200);
            g.lineWidth = 4;
            g.circle(0, 0, maxR);
            g.stroke();
            const op = ringNode.addComponent(UIOpacity);
            op.opacity = 220;
            ringNode.setScale(0.2, 0.2, 1);
            tween(ringNode)
                .to(0.3, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' })
                .start();
            tween(op)
                .to(0.3, { opacity: 0 })
                .call(() => { if (ringNode.isValid) ringNode.destroy(); })
                .start();
        } catch (e) { /* ignore */ }
    }

    /** T5: 全屏清除稀有提示 — 「🌈 全屏清除！」 */
    private spawnFullClearLabel(): void {
        try {
            const layer = this.ensureEffectsLayer();
            const labelNode = new Node('FullClearLabel');
            labelNode.parent = layer;

            // 棋盘中心偏上
            const boardUT = this.node.getComponent(UITransform);
            const cy = (boardUT && isFinite(boardUT.height) && boardUT.height > 0) ? boardUT.height * 0.15 : 60;
            labelNode.setPosition(0, cy, 0);

            const ut = labelNode.addComponent(UITransform);
            ut.setContentSize(400, 100);

            const label = labelNode.addComponent(Label);
            label.string = '🌈 全屏清除！';
            label.fontSize = 48;
            label.lineHeight = Math.round(48 * 1.15);
            label.isBold = true;
            label.color = new Color(0xFF, 0xF5, 0xE0);  // 奶白
            label.useSystemFont = true;
            label.horizontalAlign = Label.HorizontalAlign.CENTER;
            label.verticalAlign = Label.VerticalAlign.CENTER;
            label.overflow = Label.Overflow.NONE;

            // 深紫描边
            label.enableOutline = true;
            label.outlineColor = new Color(0x4A, 0x2B, 0x6B);
            label.outlineWidth = 5;

            // 投影
            label.enableShadow = true;
            label.shadowColor = new Color(0, 0, 0, 160);
            label.shadowOffset = new Vec2(0, -3);
            label.shadowBlur = 4;

            const op = labelNode.addComponent(UIOpacity);
            // scale 0.6 → 1.2 → 1.0 backOut
            labelNode.setScale(0.6, 0.6, 1);
            tween(labelNode)
                .to(0.2, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'backOut' })
                .to(0.08, { scale: new Vec3(1.0, 1.0, 1) })
                .delay(0.45)
                .start();
            // 淡出
            tween(op)
                .delay(0.65)
                .to(0.35, { opacity: 0 })
                .call(() => { if (labelNode.isValid) labelNode.destroy(); })
                .start();
        } catch (e) { /* ignore */ }
    }

    /** T3: 线消光束 — 沿整行/列画贯穿亮带，0.05s 拉开+0.15s 淡出 */
    private spawnLineBeam(row: number, col: number, isHorizontal: boolean, layer: Node): void {
        try {
            const { ROWS, COLS, TILE_SIZE, GAP } = Board;
            const totalW = COLS * TILE_SIZE + (COLS - 1) * GAP;
            const totalH = ROWS * TILE_SIZE + (ROWS - 1) * GAP;
            const bandT = TILE_SIZE * 0.5;
            const beamNode = new Node('LineBeam');
            beamNode.parent = layer;
            const pos = this.tileToLocalPosition(row, col);
            // 水平光束居中在行、垂直光束居中在列
            if (isHorizontal) {
                beamNode.setPosition(0, pos.y, 0);
            } else {
                beamNode.setPosition(pos.x, 0, 0);
            }
            const ut = beamNode.addComponent(UITransform);
            ut.setAnchorPoint(0.5, 0.5);
            const g = beamNode.addComponent(Graphics);
            g.fillColor = new Color(255, 248, 220, 180);
            if (isHorizontal) {
                ut.setContentSize(totalW, bandT);
                g.rect(-totalW / 2, -bandT / 2, totalW, bandT);
                g.fill();
                beamNode.setScale(1, 0.1, 1);
            } else {
                ut.setContentSize(bandT, totalH);
                g.rect(-bandT / 2, -totalH / 2, bandT, totalH);
                g.fill();
                beamNode.setScale(0.1, 1, 1);
            }
            const op = beamNode.addComponent(UIOpacity);
            op.opacity = 255;
            tween(beamNode)
                .to(0.05, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' })
                .start();
            tween(op)
                .delay(0.05)
                .to(0.15, { opacity: 0 })
                .call(() => { if (beamNode.isValid) beamNode.destroy(); })
                .start();
        } catch (e) { /* ignore */ }
    }

    /** T3/T5: 彩球连线 — 从中心向目标格画渐隐光线，按距离分批出现 */
    private spawnColorBombRays(
        originRow: number,
        originCol: number,
        pos: Vec3,
        layer: Node,
        targetCells?: Set<string>,
        isFullBoardClear: boolean = false,
    ): void {
        try {
            const { ROWS, COLS } = Board;
            const rayColor = new Color(0xFF, 0xB3, 0x00, 200);

            // T5: 优先使用 targetCells，没传时降级到最多色
            const targets: Array<{ r: number; c: number }> = [];
            if (targetCells && targetCells.size > 0) {
                for (const key of targetCells) {
                    const [r, c] = key.split(',').map(Number);
                    if (!isFinite(r) || !isFinite(c)) continue;
                    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
                    // 过滤彩球中心自身
                    if (r === originRow && c === originCol) continue;
                    targets.push({ r, c });
                }
            } else {
                // 降级：使用当前最多色
                const targetColor = this.getMostCommonColor();
                for (let r = 0; r < ROWS; r++) {
                    for (let c = 0; c < COLS; c++) {
                        if (this.grid[r] && this.grid[r][c] === targetColor) {
                            if (r === originRow && c === originCol) continue;
                            targets.push({ r, c });
                        }
                    }
                }
            }

            if (targets.length === 0) return;

            // T5.1: 按真实彩球原点的 Manhattan distance 排序
            targets.sort((a, b) => {
                const da = Math.abs(a.r - originRow) + Math.abs(a.c - originCol);
                const db = Math.abs(b.r - originRow) + Math.abs(b.c - originCol);
                if (da !== db) return da - db;
                if (a.r !== b.r) return a.r - b.r;
                return a.c - b.c;
            });

            // T5: 分批出现——每层延迟约 50ms
            const stepDelay = 0.05;
            const maxBatchDelay = isFullBoardClear ? 1.0 : 0.8;
            const rayLife = isFullBoardClear ? 0.45 : 0.40;

            for (let i = 0; i < targets.length; i++) {
                const { r, c } = targets[i];
                const cellPos = this.tileToLocalPosition(r, c);
                const dx = cellPos.x - pos.x;
                const dy = cellPos.y - pos.y;
                if (!isFinite(dx) || !isFinite(dy)) continue;

                const thisDelay = Math.min(i * stepDelay, maxBatchDelay);

                const rayNode = new Node('ColorRay');
                rayNode.parent = layer;
                rayNode.setPosition(pos);
                const g = rayNode.addComponent(Graphics);
                g.strokeColor = rayColor.clone();
                g.lineWidth = 3;
                g.moveTo(0, 0);
                g.lineTo(dx, dy);
                g.stroke();
                const op = rayNode.addComponent(UIOpacity);
                op.opacity = 0;

                // T5: 按距离延迟闪入 + 保持 + 淡出
                tween(op)
                    .delay(thisDelay)
                    .to(0.05, { opacity: 200 })
                    .delay(0.15)
                    .to(rayLife - 0.2, { opacity: 0 })
                    .call(() => { if (rayNode.isValid) rayNode.destroy(); })
                    .start();
            }
        } catch (e) { /* ignore */ }
    }

    /** C2 补丁: COMBO 弹字 — 随段数升级字号/scale/颜色 + 冲击弹入 */
    private showComboLabel(chainCount: number, matches: Array<{ row: number; col: number }>): void {
        // N 经 safeNum，算不出回退 1（不弹）
        const N = (typeof chainCount === 'number' && isFinite(chainCount) && chainCount >= 1) ? Math.floor(chainCount) : 1;
        if (N < 2) return; // N=1 不弹（普通消除不显示）

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

        // ★ H1: 字号/弹入 scale 随 N 增大
        const fontSize = N >= 5 ? 64 : N >= 4 ? 56 : N >= 3 ? 52 : 44;
        const popScale = N >= 5 ? 1.35 : N >= 4 ? 1.28 : N >= 3 ? 1.22 : 1.15;

        // ★ H1: 颜色随深度渐变（治愈系不刺眼）
        let fillColor: Color;
        let outlineCol: Color;
        if (N >= 5) {
            // 深连锁(N≥5)：品红描边金字
            fillColor = new Color(0xFF, 0xB3, 0x00);   // 暖金 #FFB300
            outlineCol = new Color(0xD6, 0x4A, 0x8E);   // 品红 #D64A8E
        } else if (N >= 4) {
            // 中(N4)：暖金 #FFB300
            fillColor = new Color(0xFF, 0xB3, 0x00);
            outlineCol = new Color(0x4A, 0x2B, 0x6B);
        } else {
            // 浅连锁(N2-3)：糖粉 #F5A9C7
            fillColor = new Color(0xF5, 0xA9, 0xC7);
            outlineCol = new Color(0x4A, 0x2B, 0x6B);
        }

        const comboNode = new Node('Combo');
        comboNode.parent = this.ensureEffectsLayer();
        comboNode.setPosition(cx, cy, 0);

        const comboUT = comboNode.addComponent(UITransform);
        comboUT.setContentSize(340, 90);

        const comboLabel = comboNode.addComponent(Label);
        comboLabel.string = `COMBO x${N}!`;
        comboLabel.fontSize = fontSize;
        comboLabel.lineHeight = Math.round(fontSize * 1.15);
        comboLabel.isBold = true;
        comboLabel.color = fillColor;
        comboLabel.useSystemFont = true;
        comboLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        comboLabel.verticalAlign = Label.VerticalAlign.CENTER;
        comboLabel.overflow = Label.Overflow.NONE;

        // 描边
        comboLabel.enableOutline = true;
        comboLabel.outlineColor = outlineCol;
        comboLabel.outlineWidth = N >= 5 ? 5 : 4;

        // 投影
        comboLabel.enableShadow = true;
        comboLabel.shadowColor = new Color(0, 0, 0, 160);
        comboLabel.shadowOffset = new Vec2(0, -3);
        comboLabel.shadowBlur = 4;

        const opacity = comboNode.addComponent(UIOpacity);
        comboNode.setScale(0, 0, 1);  // 从 0 开始冲击

        // scale 0→popScale→1.0 冲击弹入 (backOut) + 短暂停留 + 上浮 + 淡出
        tween(comboNode)
            .to(0.18, { scale: new Vec3(popScale, popScale, 1) }, { easing: 'backOut' })
            .to(0.08, { scale: new Vec3(1.0, 1.0, 1) })
            .delay(0.15)
            .by(0.5, { position: new Vec3(0, 50, 0) })
            .start();

        // 淡出 + 销毁
        tween(opacity)
            .delay(0.35)
            .to(0.3, { opacity: 0 })
            .call(() => {
                comboNode.destroy();
            })
            .start();

        // ★ H1: 深连锁柔色闪（N≥4）— 全屏极淡糖色柔光快速淡入淡出 0.25s
        if (N >= 4) {
            this.showChainFlash();
        }
    }

    /** H2: 在消除位置喷 4 颗同色柔光小圆点，0.35s 向外扩散+淡出后回收 */
    private spawnEliminateParticles(cx: number, cy: number, color: Color): void {
        if (!isFinite(cx) || !isFinite(cy)) return;
        const layer = this.ensureEffectsLayer();
        const count = 4; // 3-5 颗
        const baseColor = color.clone();

        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
            const dist = 25 + Math.random() * 20; // 扩散距离 25-45px
            const dx = Math.cos(angle) * dist;
            const dy = Math.sin(angle) * dist;
            const size = 8 + Math.random() * 6; // 小圆点 8-14px

            const p = new Node('Particle');
            p.parent = layer;
            p.setPosition(cx, cy, 0);

            const ut = p.addComponent(UITransform);
            ut.setContentSize(size, size);

            const g = p.addComponent(Graphics);
            g.fillColor = new Color(baseColor.r, baseColor.g, baseColor.b, 200);
            g.circle(0, 0, size / 2);
            g.fill();

            const op = p.addComponent(UIOpacity);
            op.opacity = 220;

            // 向外扩散 + 淡出 0.35s → 销毁回收
            tween(p)
                .to(0.35, { position: new Vec3(cx + dx, cy + dy, 0) }, { easing: 'quadOut' })
                .start();

            tween(op)
                .to(0.35, { opacity: 0 })
                .call(() => {
                    p.destroy();
                })
                .start();
        }
    }

    /** H1: 深连锁柔色闪 — 全屏极淡糖色柔光(alpha≤40)，0.25s 淡入淡出，用完回收 */
    private showChainFlash(): void {
        const layer = this.ensureEffectsLayer();
        const flashNode = new Node('ChainFlash');
        flashNode.parent = layer;

        // 覆盖全棋盘
        const boardUT = this.node.getComponent(UITransform);
        const fw = (boardUT && isFinite(boardUT.width) && boardUT.width > 0) ? boardUT.width : 600;
        const fh = (boardUT && isFinite(boardUT.height) && boardUT.height > 0) ? boardUT.height : 600;

        const ut = flashNode.addComponent(UITransform);
        ut.setContentSize(fw, fh);
        flashNode.setPosition(0, 0, 0);

        const g = flashNode.addComponent(Graphics);
        // 极淡糖色 alpha=35（≤40），不晃眼
        g.fillColor = new Color(0xF5, 0xA9, 0xC7, 35);
        g.rect(-fw / 2, -fh / 2, fw, fh);
        g.fill();

        const op = flashNode.addComponent(UIOpacity);
        op.opacity = 0;

        // 快速淡入(0.1s) → 淡出(0.15s) → 销毁回收
        tween(op)
            .to(0.1, { opacity: 255 })
            .to(0.15, { opacity: 0 })
            .call(() => {
                flashNode.destroy();
            })
            .start();
    }
}
