# project-bundle.md — X3.3 Repomix Source Bundle

Generated: 2026-07-11 22:15:49
Files: 9

<file path="assets/scripts/Board.ts">
(4666 lines)

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

/** V: 木箱/包装箱障碍配置（单格） */
export interface CrateCellConfig {
    row: number;
    col: number;
    layers: number; // 1=单层木箱, 2=双层木箱
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

/** W: 道具模式 */
type BoosterMode = 'none' | 'hammer';

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
    /** V: 木箱被击破一层（layersRemaining > 0 表示仍有残余） */
    onCrateDamaged?: (row: number, col: number, layersRemaining: number) => void;
    /** V: 木箱完全清除（某一格的木箱归零） */
    onCrateCleared?: (row: number, col: number) => void;
    /** W: 锤子道具解析完成（success=是否命中了棋子或木箱） */
    onHammerResolved?: (success: boolean) => void;
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
    // ── V: 木箱障碍 ──────────────────────────
    /** 木箱层数据矩阵：0=无木箱, 1=单层, 2=双层 */
    private crateLayers: number[][] = [];
    /** 木箱视觉节点矩阵（与 crateLayers 对应，null=无节点） */
    private crateNodes: Array<Array<Node | null>> = [];
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
    /** V: 加载期间暂存的木箱配置 */
    private pendingCrateConfig: CrateCellConfig[] | null = null;

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

    // ── W: 道具系统 ──────────────────────────
    /** W: 道具模式 */
    private _boosterMode: BoosterMode = 'none';
    /** W: 道具正在解析中（防重入） */
    private _boosterResolving = false;
    /** W: 棋盘 epoch — 每次 resetBoard 递增，异步流程据此检测是否已被新关卡取代 */
    private _boardEpoch = 0;

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
            const crate = this.pendingCrateConfig;
            this.pendingColorCount = null;
            this.pendingIceConfig = null;
            this.pendingCrateConfig = null;
            this.resetBoard(cc, ice ?? [], crate ?? []);
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
    public resetBoard(colorCount: number, iceConfig: IceCellConfig[] = [], crateConfig: CrateCellConfig[] = []): void {
        // W: 棋盘 epoch 递增 — 使旧异步流程作废
        this._boardEpoch++;
        // W: 清理道具状态
        this.cancelHammerMode();
        this._boosterResolving = false;

        // 头像未加载完时暂存请求
        if (!this.framesReady) {
            this.pendingColorCount = colorCount;
            this.pendingIceConfig = iceConfig.length > 0 ? iceConfig.map(item => ({ ...item })) : null;
            this.pendingCrateConfig = crateConfig.length > 0 ? crateConfig.map(item => ({ ...item })) : null;
            return;
        }

        // U1: 规范化冰层配置
        const safeIce = this.normalizeIceConfig(iceConfig);
        // V: 规范化木箱配置
        const safeCrate = this.normalizeCrateConfig(crateConfig);
        // V: 冰层和木箱不能叠在同一格 — crate 优先，同格 ice 忽略
        const crateMap = new Map<string, number>();
        for (const cr of safeCrate) crateMap.set(`${cr.row},${cr.col}`, cr.layers);
        const filteredIce = safeIce.filter(ic => !crateMap.has(`${ic.row},${ic.col}`));

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
        // V: 清理旧木箱视觉
        this.clearCrateVisuals();

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
        this._pendingIceInit = filteredIce;
        // V: 初始化木箱数据矩阵（在 generateBoard 之前设置，供其读取）
        this._pendingCrateInit = safeCrate;

        this.generateBoard();
    }

    /** U1: 暂存的冰层初始化配置（generateBoard 读取后清空） */
    private _pendingIceInit: IceCellConfig[] = [];
    /** V: 暂存的木箱初始化配置（generateBoard 读取后清空） */
    private _pendingCrateInit: CrateCellConfig[] = [];

    /** U1: 规范化冰层配置 — 去重、越界裁剪、layers 范围限制 */
    private normalizeIceConfig(raw: IceCellConfig[]): IceCellConfig[] {
        if (!Array.isArray(raw) || raw.length === 0) return [];
        const merged = new Map<string, IceCellConfig>();
        for (const item of raw) {
            if (!item || typeof item !== 'object') continue;
            // row/col 必须是有限数字
            if (typeof item.row !== 'number' || !isFinite(item.row)) continue;
            if (typeof item.col !== 'number' || !isFinite(item.col)) continue;
            const r = Math.floor(item.row);
            const c = Math.floor(item.col);
            if (r < 0 || r >= Board.ROWS || c < 0 || c >= Board.COLS) continue;
            // layers 非有限数字时回退 1
            let layers: number;
            if (typeof item.layers === 'number' && isFinite(item.layers)) {
                layers = Math.max(1, Math.min(2, Math.floor(item.layers)));
            } else {
                layers = 1;
            }
            const key = `${r},${c}`;
            const old = merged.get(key);
            if (!old || layers > old.layers) {
                merged.set(key, { row: r, col: c, layers });
            }
        }
        return Array.from(merged.values());
    }

    /** V: 规范化木箱配置 — 去重、越界裁剪、layers 范围限制（同冰层逻辑） */
    private normalizeCrateConfig(raw: CrateCellConfig[]): CrateCellConfig[] {
        if (!Array.isArray(raw) || raw.length === 0) return [];
        const merged = new Map<string, CrateCellConfig>();
        for (const item of raw) {
            if (!item || typeof item !== 'object') continue;
            if (typeof item.row !== 'number' || !isFinite(item.row)) continue;
            if (typeof item.col !== 'number' || !isFinite(item.col)) continue;
            const r = Math.floor(item.row);
            const c = Math.floor(item.col);
            if (r < 0 || r >= Board.ROWS || c < 0 || c >= Board.COLS) continue;
            let layers: number;
            if (typeof item.layers === 'number' && isFinite(item.layers)) {
                layers = Math.max(1, Math.min(2, Math.floor(item.layers)));
            } else {
                layers = 1;
            }
            const key = `${r},${c}`;
            const old = merged.get(key);
            if (!old || layers > old.layers) {
                merged.set(key, { row: r, col: c, layers });
            }
        }
        return Array.from(merged.values());
    }

    /** V: 清理所有木箱视觉节点 */
    private clearCrateVisuals(): void {
        if (this.crateNodes) {
            for (let r = 0; r < this.crateNodes.length; r++) {
                if (!this.crateNodes[r]) continue;
                for (let c = 0; c < this.crateNodes[r].length; c++) {
                    const node = this.crateNodes[r][c];
                    if (node && node.isValid) {
                        Tween.stopAllByTarget(node);
                        node.destroy();
                    }
                    this.crateNodes[r][c] = null;
                }
            }
        }
        this.crateLayers = [];
        this.crateNodes = [];
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

    // ══════════════════════════════════════════════════════════════════════════
    //  W · 局内道具系统
    // ══════════════════════════════════════════════════════════════════════════

    /** W: 进入锤子选择模式 */
    public beginHammerMode(): boolean {
        if (this._state !== BoardState.IDLE) return false;
        if (this._boosterResolving) return false;
        // 取消选中
        this.deselectTile();
        // 停止空闲提示和手势引导
        this.markPlayerActive();
        this._boosterMode = 'hammer';
        console.log('[Board] 进入锤子选择模式');
        return true;
    }

    /** W: 取消锤子选择模式 */
    public cancelHammerMode(): void {
        if (this._boosterMode === 'hammer') {
            console.log('[Board] 取消锤子选择模式');
        }
        this._boosterMode = 'none';
        // 安全取消选中
        if (this.selectedTile) {
            this.deselectTile();
        }
    }

    /** W: 获取当前道具模式（供外部查询） */
    public get boosterMode(): BoosterMode { return this._boosterMode; }

    /** W: 洗牌道具 — 不扣步、不触发消除回调 */
    public async useShuffleBooster(): Promise<boolean> {
        // 如果正在使用锤子，先取消
        if (this._boosterMode === 'hammer') {
            this.cancelHammerMode();
        }
        if (this._state !== BoardState.IDLE) return false;
        if (this._boosterResolving) return false;

        this._boosterResolving = true;
        const epoch = this._boardEpoch;

        try {
            this.deselectTile();
            this.markPlayerActive();
            this.setState(BoardState.CHAINING);

            await this.shuffleBoardWithHint();

            // epoch 检查：如果期间切关了，不操作新棋盘
            if (epoch !== this._boardEpoch) return false;

            // 确认：无现成匹配 + 有可行步
            if (this.findMatchGroups().length > 0) {
                console.warn('[Board] 洗牌后仍有匹配，判定失败');
                return false;
            }
            if (!this.hasAnyValidMove()) {
                console.warn('[Board] 洗牌后无可行步，判定失败');
                return false;
            }

            console.log('[Board] 洗牌道具成功');
            return true;
        } catch (e) {
            console.error('[Board] 洗牌道具异常:', e);
            return false;
        } finally {
            this._boosterResolving = false;
            this._boosterMode = 'none';
            if (this._state !== BoardState.LOCKED && epoch === this._boardEpoch) {
                this.setState(BoardState.IDLE);
            }
        }
    }

    /** W: 锤子核心流程 — 点击目标格后执行伤害/消除/重力/连锁 */
    private async resolveHammerAt(row: number, col: number): Promise<void> {
        // 1. 防重入
        if (this._boosterMode !== 'hammer') return;
        if (this._boosterResolving) return;
        if (this._state !== BoardState.IDLE) return;
        // W1.1: 使用纯坐标边界检查（inBounds 要求 tile 存在，木箱格 tiles=null 会误拒）
        if (!this.isCoordinateInBounds(row, col)) return;

        // 2. 判断目标
        const hasCrate = this.hasCrateAt(row, col);
        const tileNode = this.tiles[row]?.[col] ?? null;
        const hasTile =
            !!tileNode &&
            tileNode.isValid &&
            this.grid[row]?.[col] != null &&
            this.grid[row][col] >= 0;

        // 3. 无效目标 — 不消耗、不清模式、直接 return
        if (!hasCrate && !hasTile) {
            console.log('[Board] 锤子点击无效目标，保持选择状态');
            return;
        }

        // 4. 有效目标 — 开始解析
        this._boosterResolving = true;
        this._boosterMode = 'none';
        this.deselectTile();
        this.markPlayerActive();
        this.setState(BoardState.CHAINING);
        // W1.1: 清理上一轮残留的特效激活记录和顿帧，避免锤中特殊棋子被误跳过
        this._activatedSpecials.clear();
        this._pendingHitstop = 0;
        const epoch = this._boardEpoch;

        let success = false;
        let started = false;

        try {
            started = true;

            if (hasCrate) {
                // ── A. 目标是木箱 ──
                console.log(`[Board] 锤子击中木箱 (${row},${col})`);
                this.damageCrateAt(row, col);

                const crateCleared = !this.hasCrateAt(row, col);

                if (crateCleared) {
                    // 木箱清除后执行重力和连锁
                    if (epoch !== this._boardEpoch) return;
                    await this.applyGravity();
                    if (epoch !== this._boardEpoch) return;
                    await this.processChain();
                    if (epoch !== this._boardEpoch) return;

                    // 死局检测
                    if (!this.hasAnyValidMove()) {
                        console.log('[Board] 锤子后死局，自动洗牌');
                        await this.shuffleBoardWithHint();
                    }
                }
                // 木箱未清除时不执行重力/连锁
                success = true;
            } else {
                // ── B. 目标是普通棋子 ──
                console.log(`[Board] 锤子击中棋子 (${row},${col})`);
                const cells = new Set<string>([`${row},${col}`]);

                // 展开特效（如果是特殊棋子则引爆）
                const splash = this.expandSpecialSplash(cells);
                const delayMap = splash.delayMap;
                const waveStyleMap = splash.waveStyleMap;

                // 销毁
                if (epoch !== this._boardEpoch) return;
                await this.destroyCellSet(cells, delayMap, waveStyleMap);

                if (epoch !== this._boardEpoch) return;
                await this.applyGravity();
                if (epoch !== this._boardEpoch) return;
                await this.processChain();

                if (epoch !== this._boardEpoch) return;

                // 死局检测
                if (!this.hasAnyValidMove()) {
                    console.log('[Board] 锤子后死局，自动洗牌');
                    await this.shuffleBoardWithHint();
                }

                success = true;
            }
        } catch (e) {
            console.error('[Board] 锤子解析异常:', e);
        } finally {
            this._boosterResolving = false;
            this._boosterMode = 'none';

            // epoch 检查
            if (epoch === this._boardEpoch) {
                if (this._state !== BoardState.LOCKED) {
                    this.setState(BoardState.IDLE);
                }
                // W1.1: 有效目标一旦进入解析，始终回调一次（成功 true / 异常 false）
                if (started) {
                    this.callbacks.onHammerResolved?.(success);
                }
            }
        }
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
    //  V: 木箱障碍 — 公开只读接口 + 工具方法
    // ══════════════════════════════════════════════════════════════════════════

    /** V: 获取仍有木箱的格子数量 */
    public getRemainingCrateCells(): number {
        let count = 0;
        for (let r = 0; r < Board.ROWS; r++) {
            if (!this.crateLayers[r]) continue;
            for (let c = 0; c < Board.COLS; c++) {
                if (this.crateLayers[r][c] > 0) count++;
            }
        }
        return count;
    }

    /** V: 当前格是否有木箱 */
    private hasCrateAt(row: number, col: number): boolean {
        return this.crateLayers[row]?.[col] > 0;
    }

    /** V: 当前格是否是可玩的普通格子（在边界内 + 无木箱 + 有 tile） */
    private isPlayableCell(row: number, col: number): boolean {
        return row >= 0 && row < Board.ROWS && col >= 0 && col < Board.COLS
            && !this.hasCrateAt(row, col)
            && !!this.tiles[row]?.[col];
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

        // V: 先构建 crate 配置查找表
        const crateLookup = new Map<string, number>();
        if (this._pendingCrateInit && this._pendingCrateInit.length > 0) {
            for (const cr of this._pendingCrateInit) {
                crateLookup.set(`${cr.row},${cr.col}`, cr.layers);
            }
        }

        for (let r = 0; r < ROWS; r++) {
            this.grid[r] = [];
            this.tiles[r] = [];
            this.tileSpecials[r] = [];
            // U1: 初始化冰层数据矩阵
            this.iceLayers[r] = [];
            this.iceNodes[r] = [];
            // V: 初始化木箱数据矩阵
            this.crateLayers[r] = [];
            this.crateNodes[r] = [];
            for (let c = 0; c < COLS; c++) {
                const crateKey = `${r},${c}`;
                const crateLayers = crateLookup.get(crateKey) ?? 0;
                if (crateLayers > 0) {
                    // V: 木箱格 — 不创建普通 tile
                    this.grid[r][c] = -1;
                    this.tiles[r][c] = null;
                    this.tileSpecials[r][c] = SpecialType.NONE;
                    this.iceLayers[r][c] = 0;
                    this.iceNodes[r][c] = null;
                    this.crateLayers[r][c] = crateLayers;
                    this.crateNodes[r][c] = null;
                } else {
                    const colorId = this.pickSafeColor(r, c);
                    const tileNode = this.createTileNode(r, c, colorId);
                    this.grid[r][c] = colorId;
                    this.tiles[r][c] = tileNode;
                    this.tileSpecials[r][c] = SpecialType.NONE;
                    this.tileInfoMap.set(tileNode, { row: r, col: c });
                    // U1: 默认无冰
                    this.iceLayers[r][c] = 0;
                    this.iceNodes[r][c] = null;
                    this.crateLayers[r][c] = 0;
                    this.crateNodes[r][c] = null;
                }
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

        // V: 消费木箱配置（数据已在上面赋值，这里只清空暂存 + 打日志）
        if (this._pendingCrateInit && this._pendingCrateInit.length > 0) {
            this._pendingCrateInit = [];  // 消费完毕
            console.log(`[Board] 📦 木箱配置已应用: ${this.getRemainingCrateCells()} 格有木箱`);
        }

        // ★ A3: 开局/切关保证 — 无现成三连 && 有可行步（静默，无提示文字）
        this.ensureValidBoard();

        // C2: 创建特效层（确保在方块之上）
        this.ensureEffectsLayer();

        // U1: 创建障碍层 + 刷新冰层视觉
        this.refreshIceVisual();
        // V: 刷新木箱视觉
        this.refreshCrateVisual();

        // 临时验证日志（测完删除）
        const matchCount = this.findMatches().length;
        const hasMove = this.findAnyValidMove() !== null;
        console.log(`[Board] 开局校验: findMatches=${matchCount}, hasAnyValidMove=${hasMove}`);
    }

    /** 随机选一个不会与左侧 / 上方已放置方块形成三连的颜色 */
    private pickSafeColor(row: number, col: number): number {
        const forbidden = new Set<number>();

        // V: 木箱格不参与选色（返回 -1 表示无色）
        if (this.hasCrateAt(row, col)) return -1;

        if (col >= 2 && this.grid[row][col - 1] === this.grid[row][col - 2] && this.grid[row][col - 1] >= 0) {
            forbidden.add(this.grid[row][col - 1]);
        }
        if (row >= 2 && this.grid[row - 1][col] === this.grid[row - 2][col] && this.grid[row - 1][col] >= 0) {
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

    /** W1.1: 纯坐标边界检查（不要求 tile 存在，用于锤子点木箱格） */
    private isCoordinateInBounds(row: number, col: number): boolean {
        return Number.isFinite(row)
            && Number.isFinite(col)
            && row >= 0
            && row < Board.ROWS
            && col >= 0
            && col < Board.COLS;
    }

    // ── 点击逻辑（供 TileGesture 调用） ──────────────
    public onCellClick(row: number, col: number): void {
        // W: 锤子道具模式 — 直接处理，不走普通选中/交换逻辑
        if (this._boosterMode === 'hammer') {
            void this.resolveHammerAt(row, col);
            return;
        }

        if (!this.inputEnabled) {
            console.log(`[Board] 输入忽略: onCellClick(${row},${col}) state=${BoardState[this._state]}`);
            return;
        }
        // V: 木箱格不可点选
        if (this.hasCrateAt(row, col)) return;
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
        // W: 锤子模式禁止滑动交换
        if (this._boosterMode === 'hammer') return;

        if (this._state !== BoardState.IDLE) {
            console.log(`[Board] 输入忽略: trySwapByDir(${r},${c},${dr},${dc}) state=${BoardState[this._state]}`);
            return;
        }
        // V: 木箱格不可滑动交换
        if (this.hasCrateAt(r, c)) return;
        this.markPlayerActive();
        const nr = r + dr;
        const nc = c + dc;
        // V: 目标格是木箱时不交换
        if (this.hasCrateAt(nr, nc)) return;
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
        // V: 收集需要受伤害的木箱格
        const crateDamageSet = new Set<string>();

        for (const key of cells) {
            const [row, col] = key.split(',').map(Number);
            if (!isFinite(row) || !isFinite(col)) continue;
            // V: crate 格不作为普通 tile 销毁，但记为直接命中
            if (this.hasCrateAt(row, col)) {
                crateDamageSet.add(key);
                continue;
            }
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

        // V: 收集相邻木箱伤害（从被消除的普通棋子格）+ 直接命中伤害
        const allDestroyedKeys = new Set<string>();
        for (const key of cells) {
            const [r, c] = key.split(',').map(Number);
            if (!isFinite(r) || !isFinite(c)) continue;
            if (!this.hasCrateAt(r, c)) allDestroyedKeys.add(key);
        }
        const fullCrateDamage = this.collectCrateDamageFromDestroyedCells(allDestroyedKeys, crateDamageSet);
        // V: 每个木箱只受伤 1 次
        for (const crateKey of fullCrateDamage) {
            const [cr, cc] = crateKey.split(',').map(Number);
            if (!isFinite(cr) || !isFinite(cc)) continue;
            this.damageCrateAt(cr, cc);
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
        // V: 兜底保护 — 任一格是 crate 直接 return
        if (this.hasCrateAt(a.row, a.col) || this.hasCrateAt(b.row, b.col)) return;
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
                // V: 木箱格或 grid<0 必须断开 run
                const curCrate = c < COLS && this.hasCrateAt(r, c);
                const startCrate = this.hasCrateAt(r, runStart);
                const colorBreak = c === COLS || curCrate || startCrate || this.grid[r][c] < 0 || this.grid[r][runStart] < 0 || this.grid[r][c] !== this.grid[r][runStart];
                if (c === COLS || colorBreak) {
                    if (c - runStart >= 3 && !startCrate && this.grid[r][runStart] >= 0) {
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
                const curCrate = r < ROWS && this.hasCrateAt(r, c);
                const startCrate = this.hasCrateAt(runStart, c);
                const colorBreak = r === ROWS || curCrate || startCrate || this.grid[r][c] < 0 || this.grid[runStart][c] < 0 || this.grid[r][c] !== this.grid[runStart][c];
                if (r === ROWS || colorBreak) {
                    if (r - runStart >= 3 && !startCrate && this.grid[runStart][c] >= 0) {
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
                // V: 木箱格或 grid<0 断开 run
                const curCrate = c < COLS && this.hasCrateAt(r, c);
                const startCrate = this.hasCrateAt(r, runStart);
                const colorBreak = c === COLS || curCrate || startCrate || this.grid[r][c] < 0 || this.grid[r][runStart] < 0 || this.grid[r][c] !== this.grid[r][runStart];
                if (c === COLS || colorBreak) {
                    const len = c - runStart;
                    if (len >= 3 && !startCrate && this.grid[r][runStart] >= 0) {
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
                const curCrate = r < ROWS && this.hasCrateAt(r, c);
                const startCrate = this.hasCrateAt(runStart, c);
                const colorBreak = r === ROWS || curCrate || startCrate || this.grid[r][c] < 0 || this.grid[runStart][c] < 0 || this.grid[r][c] !== this.grid[runStart][c];
                if (r === ROWS || colorBreak) {
                    const len = r - runStart;
                    if (len >= 3 && !startCrate && this.grid[runStart][c] >= 0) {
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
                // V: 木箱格不枚举
                if (this.hasCrateAt(r, c)) continue;
                // V: grid<0 的格不枚举
                if (this.grid[r][c] < 0) continue;

                // 试右侧（正向条件包裹，不可交换时只跳过右模拟，不跳过下检测）
                if (
                    c + 1 < COLS &&
                    this.grid[r][c + 1] !== undefined &&
                    !this.hasCrateAt(r, c + 1) &&
                    this.grid[r][c + 1] >= 0
                ) {
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

                // 试下方（正向条件包裹，避免 continue 语义漏检）
                if (
                    r + 1 < ROWS &&
                    this.grid[r + 1] &&
                    this.grid[r + 1][c] !== undefined &&
                    !this.hasCrateAt(r + 1, c) &&
                    this.grid[r + 1][c] >= 0
                ) {
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

    /**
     * X2: 扫描所有有效交换，返回消除数最多的一个（优先四连/五连）。
     * 只读模拟，不修改实际棋盘。
     */
    public findBestValidMove(): { a: { r: number; c: number }; b: { r: number; c: number } } | null {
        const { ROWS, COLS } = Board;
        let best: { a: { r: number; c: number }; b: { r: number; c: number } } | null = null;
        let bestScore = 0;

        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (!this.grid[r] || this.grid[r][c] === undefined) continue;
                if (this.hasCrateAt(r, c)) continue;
                if (this.grid[r][c] < 0) continue;

                // 试右侧
                if (
                    c + 1 < COLS &&
                    this.grid[r][c + 1] !== undefined &&
                    !this.hasCrateAt(r, c + 1) &&
                    this.grid[r][c + 1] >= 0
                ) {
                    const va = this.grid[r][c];
                    const vb = this.grid[r][c + 1];
                    this.grid[r][c] = vb;
                    this.grid[r][c + 1] = va;
                    const score = this.findMatches().length;
                    this.grid[r][c] = va;
                    this.grid[r][c + 1] = vb;
                    if (score > bestScore) {
                        bestScore = score;
                        best = { a: { r, c }, b: { r, c: c + 1 } };
                    }
                }

                // 试下方
                if (
                    r + 1 < ROWS &&
                    this.grid[r + 1] &&
                    this.grid[r + 1][c] !== undefined &&
                    !this.hasCrateAt(r + 1, c) &&
                    this.grid[r + 1][c] >= 0
                ) {
                    const va = this.grid[r][c];
                    const vb = this.grid[r + 1][c];
                    this.grid[r][c] = vb;
                    this.grid[r + 1][c] = va;
                    const score = this.findMatches().length;
                    this.grid[r][c] = va;
                    this.grid[r + 1][c] = vb;
                    if (score > bestScore) {
                        bestScore = score;
                        best = { a: { r, c }, b: { r: r + 1, c } };
                    }
                }
            }
        }
        return best;
    }

    /**
     * X2.3: 目标感知一步启发式 — 枚举所有合法交换，按 goalType 评分选最优。
     *
     * 评估内容（只模拟当前棋盘可见状态，不预知补棋）：
     *   - 消除数量
     *   - 匹配形状（4连/5连/L-T → 特效生成）
     *   - 主动特效交换（双特效互换、彩球+普通互换）→ 模拟完整清除范围
     *   - 被动特效引爆（LINE/BOMB 在消除组中被波及）
     *   - 冰层伤害（消除格本身有冰层才计，不检查四邻）
     *   - 木箱伤害（消除格相邻木箱）
     *   - 目标颜色消除数（collect 类型）
     *   - 估算分数变化
     *   - 无效交换（无消除且无特效）→ 返回 -1，不参与选择
     *   - 平分候选随机选择（Math.random() * 0.5 扰动）
     *
     * 不做的事：
     *   - 不模拟连锁后补棋
     *   - 不读取未来 RNG
     *   - 不搜索多步
     *   - 不触发真实回调（不计分/扣步/目标/动画/伤害冰层木箱）
     */
    public findBestTargetMove(params: {
        goalType: 'score' | 'collect' | 'special' | 'ice' | 'crate';
        targetColors?: number[];     // collect: 目标 colorId 列表（仅尚未达标的）
        targetScore?: number;        // score: 目标分数
        currentScore?: number;       // score: 当前分数
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

    /**
     * X2.3: 评估单个交换的得分（不修改实际棋盘数据，模拟后还原）。
     *
     * 安全红线：
     *   1. 模拟后完整还原 grid + tileSpecials（try/finally 保证异常也能恢复）
     *   2. 不触发任何真实回调（不计分/扣步/目标/动画/伤害冰层木箱）
     *   3. 特殊交换（双特效互换、彩球+普通互换）被视为合法候选并模拟效果
     *   4. 平分候选随机选择（Math.random() * 0.5 扰动打破平局）
     */
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

            // ── 判断是否为主动特效交换 ──
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
                // ── 模拟主动特效交换效果（与 triggerSpecialExchange 一致，不触发回调）──
                if (specialA !== SpecialType.NONE) specialDetonatedCount++;
                if (specialB !== SpecialType.NONE) specialDetonatedCount++;

                if (bothSpecial) {
                    if (isLine(specialA) && isLine(specialB)) {
                        // 线+线 = 整行+整列（两个交换点）
                        for (let cc = 0; cc < COLS; cc++) { addCell(r1, cc); addCell(r2, cc); }
                        for (let rr = 0; rr < ROWS; rr++) { addCell(rr, c1); addCell(rr, c2); }
                    } else if (isBomb(specialA) && isBomb(specialB)) {
                        // 炸弹+炸弹 = 两个交换点各 5×5
                        for (let dr = -2; dr <= 2; dr++)
                            for (let dc = -2; dc <= 2; dc++) { addCell(r1 + dr, c1 + dc); addCell(r2 + dr, c2 + dc); }
                    } else if ((isBomb(specialA) && isLine(specialB)) || (isLine(specialA) && isBomb(specialB))) {
                        // 炸弹+线 = 炸弹位置行±1共3行 + 列±1共3列
                        // 交换后 BOMB 在 specialA 位置(r1,c1) 或 specialB 位置(r2,c2)
                        const br = isBomb(specialA) ? r1 : r2;
                        const bc = isBomb(specialA) ? c1 : c2;
                        for (let cc = 0; cc < COLS; cc++)
                            for (let dr = -1; dr <= 1; dr++) addCell(br + dr, cc);
                        for (let rr = 0; rr < ROWS; rr++)
                            for (let dc = -1; dc <= 1; dc++) addCell(rr, bc + dc);
                    } else if ((isColor(specialA) && (isLine(specialB) || isBomb(specialB)))
                            || ((isLine(specialA) || isBomb(specialA)) && isColor(specialB))) {
                        // 彩球+线/炸弹 = 场上最多色所有格 + 两个交换点
                        const targetColor = this.getMostCommonColor();
                        for (let r = 0; r < ROWS; r++)
                            for (let c = 0; c < COLS; c++)
                                if (this.grid[r] && this.grid[r][c] === targetColor) addCell(r, c);
                        addCell(r1, c1);
                        addCell(r2, c2);
                    } else if (isColor(specialA) && isColor(specialB)) {
                        // 彩球+彩球 = 全盘清屏
                        for (let r = 0; r < ROWS; r++)
                            for (let c = 0; c < COLS; c++) addCell(r, c);
                    }
                } else if (colorPlusNormal) {
                    // 彩球+普通 = 清该色全盘 + 彩球自身
                    // 交换后彩球在 specialA 位置(r1,c1) 或 specialB 位置(r2,c2)
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
                // ── 非特效交换：检查普通匹配 ──
                // LINE/BOMB + normal 不触发主动特效交换，走普通匹配流程
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

                    // 特效棋子被动引爆：仅在消除组中才计数
                    // 交换后 specialA 在 (r1,c1)，specialB 在 (r2,c2)
                    if (eliminatedSet.has(`${r1},${c1}`) && specialA !== SpecialType.NONE) specialDetonatedCount++;
                    if (eliminatedSet.has(`${r2},${c2}`) && specialB !== SpecialType.NONE) specialDetonatedCount++;

                    scoreDelta = eliminatedCount * 30;
                    if (specialCreatedCount > 0) scoreDelta += specialCreatedCount * 200;
                    if (specialDetonatedCount > 0) scoreDelta += specialDetonatedCount * 300;
                }
            }

            // ── 目标颜色消除统计 ──
            if (params.targetColors && params.targetColors.length > 0 && eliminatedSet.size > 0) {
                for (const key of eliminatedSet) {
                    const [er, ec] = key.split(',').map(Number);
                    const colorId = this.grid[er]?.[ec] ?? -1;
                    if (params.targetColors.includes(colorId)) {
                        targetColorEliminated++;
                    }
                }
            }

            // ── 冰层伤害统计 ──
            // 规则：只统计被消除格本身覆盖的冰层，不统计四邻
            // 特效覆盖到冰层格时也计伤害（冰层格在 eliminatedSet 中即算）
            for (const key of eliminatedSet) {
                const [er, ec] = key.split(',').map(Number);
                if (this.iceLayers[er]?.[ec] > 0) iceDamageCount++;
            }

            // ── 木箱伤害统计 ──
            // 规则（与 collectCrateDamageFromDestroyedCells 一致）：
            //   A. 被消除棋子格的四邻有木箱 → 计伤害
            //   B. 特效直接覆盖到木箱格 → 计伤害（direct hit）
            //   C. 使用 Set 去重，每个木箱只计 1 次
            {
                const crateHitSet = new Set<string>();
                const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
                for (const key of eliminatedSet) {
                    const [er, ec] = key.split(',').map(Number);
                    if (this.hasCrateAt(er, ec)) {
                        // B: 直接命中木箱格
                        crateHitSet.add(key);
                    } else {
                        // A: 四邻木箱
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

            // ── 无效交换过滤：无消除且无特效引爆 → 返回 -1 ──
            if (eliminatedCount === 0 && specialDetonatedCount === 0) return -1;

            // ── 按目标类型计算综合评分 ──
            let totalScore = 0;

            // 通用基础分
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

            // 加微小随机扰动打破平局（结构分为整数，0.5 扰动不会跨区间）
            totalScore += Math.random() * 0.5;

            return totalScore;
        } finally {
            // ── 无论正常返回还是异常，都必须恢复 ──
            this.grid[r1][c1] = va;
            this.grid[r2][c2] = vb;
            if (this.tileSpecials[r1]) this.tileSpecials[r1][c1] = sa;
            if (this.tileSpecials[r2]) this.tileSpecials[r2][c2] = sb;
        }
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
                    // V: crate 格保持空，不填普通 tile
                    if (this.hasCrateAt(r, c)) continue;
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
                    // V: crate 格保持空，不填普通 tile
                    if (this.hasCrateAt(r, c)) continue;
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
        // V: 木箱数据保持不变（forceRegenerate 只重置方块，不重置障碍）

        // 直接调 generateBoard（内部用 pickSafeColor 保证无三连）
        for (let r = 0; r < ROWS; r++) {
            this.grid[r] = [];
            this.tiles[r] = [];
            this.tileSpecials[r] = [];
            // U1: 确保冰层矩阵存在（forceRegenerate 不清冰）
            if (!this.iceLayers[r]) this.iceLayers[r] = [];
            if (!this.iceNodes[r]) this.iceNodes[r] = [];
            // V: 确保木箱矩阵存在（forceRegenerate 不清木箱）
            if (!this.crateLayers[r]) this.crateLayers[r] = [];
            if (!this.crateNodes[r]) this.crateNodes[r] = [];
            for (let c = 0; c < COLS; c++) {
                if (this.iceLayers[r][c] === undefined) this.iceLayers[r][c] = 0;
                if (!this.iceNodes[r][c]) this.iceNodes[r][c] = null;
                if (this.crateLayers[r][c] === undefined) this.crateLayers[r][c] = 0;
                if (!this.crateNodes[r][c]) this.crateNodes[r][c] = null;

                // V: crate 格保持空，不创建 tile
                if (this.hasCrateAt(r, c)) {
                    this.grid[r][c] = -1;
                    this.tiles[r][c] = null;
                    this.tileSpecials[r][c] = SpecialType.NONE;
                    continue;
                }

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
        this.refreshIceVisual();    // U1: 刷新冰层视觉
        this.refreshCrateVisual();  // V: 刷新木箱视觉
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
        const crateDamageSet = new Set<string>();
        for (const key of destroyedCells) {
            const [row, col] = key.split(',').map(Number);
            if (!isFinite(row) || !isFinite(col)) continue;
            // V: crate 格不作为普通 tile 销毁，但记为直接命中
            if (this.hasCrateAt(row, col)) {
                crateDamageSet.add(key);
                continue;
            }
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

        // V: 收集相邻木箱伤害 + 直接命中伤害，每个木箱只受伤 1 次
        const allDestroyedKeys = new Set<string>();
        for (const key of destroyedCells) {
            const [r, c] = key.split(',').map(Number);
            if (!isFinite(r) || !isFinite(c)) continue;
            if (!this.hasCrateAt(r, c)) allDestroyedKeys.add(key);
        }
        const fullCrateDamage = this.collectCrateDamageFromDestroyedCells(allDestroyedKeys, crateDamageSet);
        for (const crateKey of fullCrateDamage) {
            const [cr, cc] = crateKey.split(',').map(Number);
            if (!isFinite(cr) || !isFinite(cc)) continue;
            this.damageCrateAt(cr, cc);
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
            // V: 按列被 crate 分割成多个垂直区段，每个区段独立下落
            let bottom = ROWS - 1;
            while (bottom >= 0) {
                // 跳过 crate 格（确保 crate 格为空）
                while (bottom >= 0 && this.hasCrateAt(bottom, c)) {
                    this.grid[bottom][c] = -1;
                    this.tiles[bottom][c] = null;
                    this.tileSpecials[bottom][c] = SpecialType.NONE;
                    bottom--;
                }
                if (bottom < 0) break;

                // 找到当前区段的 top（不含 crate 的连续行）
                let top = bottom;
                while (top >= 0 && !this.hasCrateAt(top, c)) {
                    top--;
                }
                // top 现在指向 crate 格或 -1，区段范围是 [top+1, bottom]
                const segTop = top + 1;
                const segBottom = bottom;

                // 在区段内收集 survivors（从下往上）
                const survivors: { colorId: number; node: Node; special: SpecialType }[] = [];
                for (let r = segBottom; r >= segTop; r--) {
                    const node = this.tiles[r]?.[c];
                    if (this.grid[r][c] >= 0 && node && node.isValid) {
                        survivors.push({ colorId: this.grid[r][c], node, special: this.tileSpecials[r][c] });
                    }
                    // 清空该格
                    this.grid[r][c] = -1;
                    this.tiles[r][c] = null;
                    this.tileSpecials[r][c] = SpecialType.NONE;
                }

                // 从区段底部往上填 survivor
                for (let i = 0; i < survivors.length; i++) {
                    const targetRow = segBottom - i;
                    const { colorId, node, special } = survivors[i];
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
                        const cells = dy / (TILE_SIZE + GAP);
                        const dur = Math.max(0.05, Board.FALL_BASE_DURATION * Math.sqrt(Math.max(1, cells)));
                        const colDelay = c * Board.COLUMN_DELAY;
                        promises.push(this.tweenPromise(node, dur, { position: targetPos }, 'quadIn', colDelay));
                    }
                }

                // 区段顶部生成新棋子补满
                const segLen = segBottom - segTop + 1;
                const newCount = segLen - survivors.length;
                for (let i = 0; i < newCount; i++) {
                    const targetRow = segTop + i;
                    const colorId = Math.floor(Math.random() * this.colorCount);
                    const tileNode = this.createTileNode(targetRow, c, colorId);

                    // 从区段顶部上方生成
                    const startRow = segTop - (newCount - i);
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

                bottom = top - 1;  // 继续处理 crate 上方的区段
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
                    if (node.isValid) {
                        Tween.stopAllByTarget(node);
                        node.destroy();
                    }
                    // 只有矩阵里仍然是当时那个旧节点时才清引用
                    if (this.iceNodes[row]?.[col] === node) {
                        this.iceNodes[row][col] = null;
                    }
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

    // ══════════════════════════════════════════════════════════════════════════
    //  V: 木箱障碍 — 视觉层管理 + 受伤逻辑
    // ══════════════════════════════════════════════════════════════════════════

    /** V: 根据 crateLayers 数据刷新全部木箱视觉节点 */
    private refreshCrateVisual(): void {
        if (!this.crateLayers || this.crateLayers.length === 0) return;
        const layer = this.ensureObstacleLayer();

        for (let r = 0; r < Board.ROWS; r++) {
            if (!this.crateLayers[r]) continue;
            for (let c = 0; c < Board.COLS; c++) {
                const layers = this.crateLayers[r][c];
                const existing = this.crateNodes[r]?.[c] ?? null;

                if (layers <= 0) {
                    // 无木箱 → 销毁旧节点
                    if (existing && existing.isValid) {
                        Tween.stopAllByTarget(existing);
                        existing.destroy();
                    }
                    if (this.crateNodes[r]) this.crateNodes[r][c] = null;
                } else {
                    // 有木箱 → 创建/更新视觉
                    if (!existing || !existing.isValid) {
                        const node = this.createCrateNode(r, c, layers);
                        node.parent = layer;
                        if (!this.crateNodes[r]) this.crateNodes[r] = [];
                        this.crateNodes[r][c] = node;
                    } else {
                        this.drawCrateNode(existing, layers);
                    }
                }
            }
        }
    }

    /** V: 创建木箱视觉节点 */
    private createCrateNode(row: number, col: number, layers: number): Node {
        const node = new Node(`Crate_${row}_${col}`);
        const pos = this.tileToLocalPosition(row, col);
        node.setPosition(pos);

        const ut = node.addComponent(UITransform);
        ut.setContentSize(Board.TILE_SIZE, Board.TILE_SIZE);

        // W: 为木箱节点添加触摸入口 — 仅在锤子模式下生效
        node.on(Node.EventType.TOUCH_END, () => {
            if (this._boosterMode === 'hammer') {
                this.onCellClick(row, col);
            }
        });

        this.drawCrateNode(node, layers);
        return node;
    }

    /** V: 在节点上绘制木箱图形（layers=1 单层, layers=2 双层） */
    private drawCrateNode(node: Node, layers: number): void {
        let g = node.getComponent(Graphics);
        if (!g) g = node.addComponent(Graphics);
        g.clear();

        const ts = Board.TILE_SIZE;
        const half = ts / 2;
        const radius = 6;

        if (layers >= 2) {
            // 双层木箱：深棕色 + 加固带
            g.fillColor = new Color(0x8B, 0x5A, 0x2B, 230);
            g.roundRect(-half, -half, ts, ts, radius);
            g.fill();
            // 描边
            g.strokeColor = new Color(0x5A, 0x3A, 0x1A, 255);
            g.lineWidth = 3;
            g.roundRect(-half, -half, ts, ts, radius);
            g.stroke();
            // 内层边框（加固带）
            g.strokeColor = new Color(0x6B, 0x42, 0x1F, 200);
            g.lineWidth = 2;
            g.roundRect(-half + 5, -half + 5, ts - 10, ts - 10, 4);
            g.stroke();
            // 十字加固
            g.strokeColor = new Color(0x5A, 0x3A, 0x1A, 180);
            g.lineWidth = 2;
            g.moveTo(-half + 8, 0);
            g.lineTo(half - 8, 0);
            g.moveTo(0, -half + 8);
            g.lineTo(0, half - 8);
            g.stroke();
        } else {
            // 单层木箱：中棕色
            g.fillColor = new Color(0xA0, 0x6B, 0x35, 220);
            g.roundRect(-half, -half, ts, ts, radius);
            g.fill();
            // 描边
            g.strokeColor = new Color(0x6B, 0x42, 0x1F, 255);
            g.lineWidth = 2;
            g.roundRect(-half, -half, ts, ts, radius);
            g.stroke();
            // 木纹斜线
            g.strokeColor = new Color(0x7A, 0x4F, 0x25, 160);
            g.lineWidth = 1.5;
            for (let i = -half + 10; i < half; i += 14) {
                g.moveTo(i, -half + 4);
                g.lineTo(i + 8, -half + 12);
            }
            g.stroke();
        }
    }

    /** V: 对指定格的木箱造成 1 点伤害（唯一入口） */
    private damageCrateAt(row: number, col: number): void {
        if (row < 0 || row >= Board.ROWS || col < 0 || col >= Board.COLS) return;
        if (!this.crateLayers[row]) return;
        const current = this.crateLayers[row][col];
        if (current <= 0) return;

        const remaining = current - 1;
        this.crateLayers[row][col] = remaining;

        // 视觉效果
        this.playCrateHitEffect(row, col, remaining <= 0);

        if (remaining <= 0) {
            // 木箱完全清除
            this.callbacks.onCrateCleared?.(row, col);
            console.log(`[Board] 📦 木箱清除 (${row},${col})`);

            // 延迟销毁视觉节点（等动画播完）
            const node = this.crateNodes[row]?.[col] ?? null;
            if (node && node.isValid) {
                this.scheduleOnce(() => {
                    if (node.isValid) {
                        Tween.stopAllByTarget(node);
                        node.destroy();
                    }
                    if (this.crateNodes[row]?.[col] === node) {
                        this.crateNodes[row][col] = null;
                    }
                }, 0.3);
            }
            // 清掉该格 grid/tiles/special 残留
            this.grid[row][col] = -1;
            this.tiles[row][col] = null;
            this.tileSpecials[row][col] = SpecialType.NONE;
        } else {
            // 仍有残余木箱 → 更新视觉
            const node = this.crateNodes[row]?.[col] ?? null;
            if (node && node.isValid) {
                this.drawCrateNode(node, remaining);
            }
            this.callbacks.onCrateDamaged?.(row, col, remaining);
            console.log(`[Board] 📦 木箱受损 (${row},${col}) → 剩余 ${remaining} 层`);
        }
    }

    /**
     * V: 从被消除棋子格收集相邻木箱伤害 + 直接命中木箱伤害
     * @param destroyedCells 被消除的普通棋子格集合
     * @param directHitCells 特效直接命中的格集合（可能包含 crate 格）
     * @returns 需要受伤的木箱格集合
     */
    private collectCrateDamageFromDestroyedCells(
        destroyedCells: Set<string>,
        directHitCells?: Set<string>,
    ): Set<string> {
        const damageSet = new Set<string>();

        // A. 相邻伤害：对每个被消除棋子格，检查四邻是否有 crate
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (const key of destroyedCells) {
            const [r, c] = key.split(',').map(Number);
            if (!isFinite(r) || !isFinite(c)) continue;
            for (const [dr, dc] of dirs) {
                const nr = r + dr;
                const nc = c + dc;
                if (nr < 0 || nr >= Board.ROWS || nc < 0 || nc >= Board.COLS) continue;
                if (this.hasCrateAt(nr, nc)) {
                    damageSet.add(`${nr},${nc}`);
                }
            }
        }

        // B. 直接命中：特效覆盖到 crate 格
        if (directHitCells) {
            for (const key of directHitCells) {
                const [r, c] = key.split(',').map(Number);
                if (!isFinite(r) || !isFinite(c)) continue;
                if (this.hasCrateAt(r, c)) {
                    damageSet.add(`${r},${c}`);
                }
            }
        }

        return damageSet;
    }

    /** V: 木箱被击中/清除时的视觉特效 */
    private playCrateHitEffect(row: number, col: number, isCleared: boolean): void {
        const layer = this.ensureEffectsLayer();
        const pos = this.tileToLocalPosition(row, col);

        // 木屑粒子
        const shardNode = new Node('CrateShard');
        shardNode.parent = layer;
        shardNode.setPosition(pos);

        const shardCount = isCleared ? 8 : 4;
        const shardColors = [
            new Color(0x8B, 0x5A, 0x2B, 220),
            new Color(0xA0, 0x6B, 0x35, 200),
            new Color(0x6B, 0x42, 0x1F, 180),
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

        // 木箱节点抖动
        const crateNode = this.crateNodes[row]?.[col];
        if (crateNode && crateNode.isValid) {
            const origScale = crateNode.getScale();
            tween(crateNode)
                .to(0.05, { scale: new Vec3(0.9, 0.9, 1) })
                .to(0.05, { scale: new Vec3(origScale.x, origScale.y, origScale.z) })
                .start();
        }

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

</file>

<file path="assets/scripts/GameManager.ts">
(7074 lines)

import {
    _decorator,
    Component,
    Node,
    Label,
    UITransform,
    Sprite,
    Color,
    Button,
    Vec3,
    builtinResMgr,
    SpriteFrame,
    Widget,
    screen,
    view,
    sys,
    view as ccView,
    tween,
    Tween,
    Graphics,
    Layout,
    BlockInputEvents,
    UIOpacity,
    resources,
} from 'cc';
import { Board, BoardCallbacks, IceCellConfig, CrateCellConfig } from './Board';
import { AudioManager } from './AudioManager';
import { VibrateManager } from './VibrateManager';
import { AdManager } from './AdManager';
import { GameClubEntry } from './GameClubEntry';
import { RecorderManager } from './RecorderManager';
import { SaveManager } from './SaveManager';

// 抩音小游戏全局 API（非抩音环境下不存在）
declare const tt: any;

const { ccclass } = _decorator;

// WeChat mini-game 全局 API（非微信环境下不存在）
declare const wx: any;

/** 过关目标类型 */
type GoalType = 'score' | 'collect' | 'special' | 'ice' | 'crate';

/** X1: 难度档位 */
type DifficultyTier = 'tutorial' | 'normal' | 'hard' | 'boss';

/** X2: 单局目标进度快照 */
interface GoalProgressSnapshot {
    current: number;
    target: number;
    ratio: number;
}

/** X2: 单局难度测试记录 */
interface DifficultyRunRecord {
    version: 1;
    timestamp: string;

    level: number;
    chapter: number;
    difficulty: DifficultyTier;
    designIntent: string;
    goalType: GoalType;

    result: 'win' | 'fail';
    attemptInSession: number;

    baseMoves: number;
    validMovesUsed: number;
    stepsRemaining: number;
    score: number;
    targetScore: number;  // X3: 目标分数（score 类型有值，其余为 0）

    goalCurrent: number;
    goalTarget: number;
    goalProgress: number;

    // X3: collect 详情 — 每个目标颜色的最终收集量
    collectDetail?: { color: string; have: number; need: number }[];

    hammerUsed: boolean;
    shuffleUsed: boolean;
    addStepsUsed: boolean;
    continueAdUsed: boolean;

    assisted: boolean;
}

/** X2: 单关累计统计 */
interface DifficultyLevelSummary {
    level: number;
    difficulty: DifficultyTier;
    goalType: GoalType;  // X3: 关卡目标类型

    attempts: number;
    wins: number;
    fails: number;
    winRate: number;

    cleanAttempts: number;
    cleanWins: number;
    cleanWinRate: number;

    assistedAttempts: number;
    assistedWins: number;
    assistedWinRate: number;

    avgValidMoves: number;
    avgWinStepsRemaining: number;
    avgFailProgress: number;

    hammerUseRate: number;
    shuffleUseRate: number;
    addStepsUseRate: number;
    continueAdUseRate: number;

    // X3: 高分关额外指标
    targetScore: number;           // 目标分数（非 score 类型为 0）
    scores: number[];              // 每局最终分数列表
    avgScore: number;              // 平均分
    medianScore: number;           // 中位数
    minScore: number;              // 最低分
    maxScore: number;              // 最高分
    scoreReachedCount: number;     // 达到目标分数的局数（含通关）

    // X3: 收集关额外指标
    collectDetail: { color: string; avgHave: number; need: number }[];  // 每个目标颜色的平均收集量
}

/** 关卡配置 */
interface LevelConfig {
    level: number;
    chapter: number;            // 1/2/3
    isBoss: boolean;            // 章末 Boss 关（难度峰值）
    goalType: GoalType;         // 过关目标类型
    targetScore?: number;       // goalType=score 时的目标分
    goalColor?: string | string[]; // goalType=collect 时收集的怪物色键，可多色
    goalCount?: number | number[]; // 对应 goalColor 的收集数量（多色时一一对应）
    specialCount?: number;      // goalType=special 时需引爆的特效块总数
    moves: number;              // 总步数
    colors: number;             // 本关颜色数（5 或 6）
    /** U1: 冰层配置 */
    ice?: IceCellConfig[];
    /** U1: 冰层清除目标数（goalType=ice 时需清除的冰格数） */
    iceTarget?: number;
    /** V: 木箱配置 */
    crate?: CrateCellConfig[];
    /** V: 木箱清除目标数（goalType=crate 时需清除的木箱格数） */
    crateTarget?: number;
    /** X1: 难度档位（教学/普通/困难/Boss） */
    difficulty: DifficultyTier;
    /** X1: 设计意图（开发阶段说明该关主要让玩家做什么） */
    designIntent: string;
}

/** 颜色键 → colorId 映射 */
const COLOR_KEY_MAP: Record<string, number> = {
    'pink': 0,
    'blue': 1,
    'green': 2,
    'yellow': 3,
    'mon_purple': 4,
    'orange': 5,
};

/** colorId → emoji 映射（HUD 收集进度显示用） */
const COLOR_EMOJI_MAP: string[] = ['🐰', '🐻', '🐘', '🦌', '🐉', '🦊'];

/** J1: 公仔名字（monId 0-5） */
const MON_NAME: string[] = ['奶糖', '云宝', '抹茶', '小满', '葡萄', '蜜桃'];

/** J1: 公仔性格文案（monId 0-5） */
const MON_DESC: string[] = [
    '爱睡午觉的软妹子',
    '慢半拍的暖心担当',
    '记性超好的小书虫',
    '蹦蹦跳跳的元气鹿',
    '爱发光的许愿龙',
    '古灵精怪的收藏控',
];

/** J1: 公仔稀有度（monId 0-5） */
const MON_RARITY: ('R' | 'SR' | 'SSR')[] = ['R', 'R', 'R', 'SR', 'SR', 'SSR'];

/** Q1: 主题数据（id 0-3，0=免费默认） */
const THEME_DATA: { name: string; bg: Color; emoji: string }[] = [
    { name: '默认粉', bg: new Color(0xFD, 0xF2, 0xF8), emoji: '🌸' },
    { name: '薄荷绿', bg: new Color(0xEA, 0xF5, 0xEF), emoji: '🍃' },
    { name: '暮光紫', bg: new Color(0xF0, 0xEA, 0xF7), emoji: '🔮' },
    { name: '深海蓝', bg: new Color(0xE8, 0xF0, 0xFA), emoji: '🌊' },
];

/** Q1: 配饰数据（id 0-2，全部需广告解锁） */
const ACCESSORY_DATA: { name: string; emoji: string }[] = [
    { name: '王冠', emoji: '👑' },
    { name: '墨镜', emoji: '🕶️' },
    { name: '蝴蝶结', emoji: '🎀' },
];

/** Widget 对齐参数 */
interface WidgetOptions {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    hCenter?: number;
    vCenter?: number;
}

@ccclass('GameManager')
export class GameManager extends Component {
    // ── 关卡配置 ──────────────────────────────
    private readonly levelConfigs: LevelConfig[] = [
        // —— 第 1 章：入门（5 色）——
        { level: 1,  chapter: 1, isBoss: false, goalType: 'score',   targetScore: 600,  moves: 25, colors: 5,
          difficulty: 'tutorial', designIntent: '完成第一次普通三消，建立"交换—消除—得分"认知' },
        { level: 2,  chapter: 1, isBoss: false, goalType: 'score',   targetScore: 900,  moves: 22, colors: 5,
          difficulty: 'normal',   designIntent: '在宽松步数内练习连续有效交换' },
        { level: 3,  chapter: 1, isBoss: false, goalType: 'collect', goalColor: 'pink', goalCount: 18, moves: 20, colors: 5,
          difficulty: 'normal',   designIntent: '第一次学习指定颜色收集目标' },
        { level: 4,  chapter: 1, isBoss: false, goalType: 'score',   targetScore: 1600, moves: 20, colors: 5,
          difficulty: 'hard',     designIntent: '引导玩家通过四连和自然连锁提高单步收益' },
        { level: 5,  chapter: 1, isBoss: true,  goalType: 'score',   targetScore: 2200, moves: 22, colors: 5,
          difficulty: 'boss',     designIntent: '第一章综合考试，要求稳定制造高价值消除但不依赖道具' },
        // —— 第 2 章：进阶（6 色）——
        { level: 6,  chapter: 2, isBoss: false, goalType: 'score',   targetScore: 1400, moves: 26, colors: 6,
          difficulty: 'tutorial', designIntent: '用宽松条件适应六种颜色带来的匹配率下降' },
        { level: 7,  chapter: 2, isBoss: false, goalType: 'collect', goalColor: ['blue', 'green'], goalCount: [16, 16], moves: 24, colors: 6,
          difficulty: 'normal',   designIntent: '在六色棋盘中练习双颜色收集' },
        { level: 8,  chapter: 2, isBoss: false, goalType: 'score',   targetScore: 2000, moves: 24, colors: 6,
          difficulty: 'hard',     designIntent: '要求玩家开始主动追求四连、五连和连锁得分' },
        { level: 9,  chapter: 2, isBoss: false, goalType: 'special', specialCount: 3, moves: 24, colors: 6,
          difficulty: 'normal',   designIntent: '明确教学特殊棋子的制造和引爆' },
        { level: 10, chapter: 2, isBoss: true,  goalType: 'score',   targetScore: 2500, moves: 24, colors: 6,
          difficulty: 'boss',     designIntent: '第二章综合考试，通过特殊棋子提升分数效率' },
        // —— 第 3 章：挑战（6 色）——
        { level: 11, chapter: 3, isBoss: false, goalType: 'score',   targetScore: 2100, moves: 26, colors: 6,
          difficulty: 'normal',   designIntent: '章节喘息关，稳定得分并复习六色棋盘' },
        { level: 12, chapter: 3, isBoss: false, goalType: 'collect', goalColor: ['mon_purple', 'orange'], goalCount: [18, 18], moves: 26, colors: 6,
          difficulty: 'normal',   designIntent: '双颜色收集，要求兼顾目标但保留足够容错' },
        { level: 13, chapter: 3, isBoss: false, goalType: 'special', specialCount: 5, moves: 24, colors: 6,
          difficulty: 'hard',     designIntent: '要求主动制造和引爆特殊棋子，为后续高分关做准备' },
        { level: 14, chapter: 3, isBoss: false, goalType: 'score',   targetScore: 2200, moves: 24, colors: 6,
          difficulty: 'hard',     designIntent: '使用特殊棋子和连锁完成高分目标，但不需要广告续步' },
        { level: 15, chapter: 3, isBoss: true,  goalType: 'score',   targetScore: 2400, moves: 26, colors: 6,
          difficulty: 'boss',     designIntent: '第三章综合考试，考察特殊棋子、组合与连锁效率' },
        // —— 第 4 章：新篇 · 冰层障碍（6 色）——
        // U1: L16 冰层入门 — 清除 8 格单层冰
        { level: 16, chapter: 4, isBoss: false, goalType: 'ice', iceTarget: 8, moves: 24, colors: 6,
          difficulty: 'tutorial', designIntent: '明确学习消除冰层覆盖格的棋子，单层冰一次清除',
          ice: [
              {row:1,col:1,layers:1},{row:1,col:6,layers:1},
              {row:3,col:3,layers:1},{row:3,col:4,layers:1},
              {row:4,col:3,layers:1},{row:4,col:4,layers:1},
              {row:6,col:1,layers:1},{row:6,col:6,layers:1},
          ],
        },
        // U1: L17 收集 + 冰层障碍
        { level: 17, chapter: 4, isBoss: false, goalType: 'collect', goalColor: ['blue', 'green', 'yellow'], goalCount: [16, 16, 16], moves: 26, colors: 6,
          difficulty: 'normal',   designIntent: '在颜色收集过程中顺带处理冰层，不要求清完所有冰',
          ice: [
              {row:0,col:2,layers:1},{row:0,col:5,layers:1},
              {row:2,col:0,layers:1},{row:2,col:7,layers:1},
              {row:3,col:3,layers:1},{row:3,col:4,layers:1},
              {row:4,col:3,layers:1},{row:4,col:4,layers:1},
              {row:5,col:0,layers:1},{row:5,col:7,layers:1},
          ],
        },
        // U1: L18 特效引爆 + 混合冰层（单层+双层）
        { level: 18, chapter: 4, isBoss: false, goalType: 'special', specialCount: 4, moves: 25, colors: 6,
          difficulty: 'normal',   designIntent: '学习利用特殊棋子批量命中单层和双层冰',
          ice: [
              {row:1,col:1,layers:2},{row:1,col:6,layers:2},
              {row:3,col:2,layers:1},{row:3,col:5,layers:1},
              {row:4,col:2,layers:1},{row:4,col:5,layers:1},
              {row:6,col:1,layers:2},{row:6,col:6,layers:2},
          ],
        },
        // U1: L19 高分 + 重冰（全双层）
{ level: 19, chapter: 4, isBoss: false, goalType: 'score',   targetScore: 2700, moves: 26, colors: 6,
          difficulty: 'hard',     designIntent: '在双层冰干扰下制造连锁和特殊棋子获得高分',
          ice: [
              {row:0,col:1,layers:2},{row:0,col:3,layers:2},{row:0,col:5,layers:2},{row:0,col:7,layers:2},
              {row:2,col:0,layers:2},{row:2,col:2,layers:2},{row:2,col:5,layers:2},{row:2,col:7,layers:2},
              {row:5,col:0,layers:2},{row:5,col:2,layers:2},{row:5,col:5,layers:2},{row:5,col:7,layers:2},
          ],
        },
        // U1: L20 Boss — 清除 14 格混合冰层
        { level: 20, chapter: 4, isBoss: true, goalType: 'ice', iceTarget: 14, moves: 32, colors: 6,
          difficulty: 'boss',     designIntent: '清除全部混合冰层，优先规划双层冰和特效覆盖范围',
          ice: [
              {row:0,col:0,layers:2},{row:0,col:3,layers:2},{row:0,col:7,layers:2},
              {row:2,col:1,layers:1},{row:2,col:4,layers:2},{row:2,col:6,layers:1},
              {row:4,col:1,layers:1},{row:4,col:4,layers:2},{row:4,col:6,layers:1},
              {row:5,col:3,layers:2},{row:6,col:0,layers:1},{row:6,col:7,layers:2},
              {row:7,col:2,layers:1},{row:7,col:5,layers:1},
          ],
        },
        // —— 第 5 章：木箱障碍（6 色）——
        // V: L21 木箱入门 — 清除 6 个单层木箱
        { level: 21, chapter: 5, isBoss: false, goalType: 'crate', crateTarget: 6, moves: 28, colors: 6,
          difficulty: 'tutorial', designIntent: '学习通过相邻消除拆箱，并观察木箱对重力的阻断',
          crate: [
              {row:2,col:2,layers:1},{row:2,col:5,layers:1},
              {row:3,col:3,layers:1},{row:3,col:4,layers:1},
              {row:5,col:2,layers:1},{row:5,col:5,layers:1},
          ],
        },
        // V: L22 收集 + 木箱
        { level: 22, chapter: 5, isBoss: false, goalType: 'collect', goalColor: ['pink', 'blue'], goalCount: [19, 19], moves: 25, colors: 6,
          difficulty: 'normal',   designIntent: '在木箱切割的棋盘中完成双颜色收集',
          crate: [
              {row:1,col:1,layers:1},{row:1,col:6,layers:1},
              {row:3,col:0,layers:1},{row:3,col:3,layers:1},
              {row:3,col:4,layers:1},{row:3,col:7,layers:1},
              {row:5,col:1,layers:1},{row:5,col:6,layers:1},
          ],
        },
        // V: L23 特效 + 木箱（含 2 个双层）
        { level: 23, chapter: 5, isBoss: false, goalType: 'special', specialCount: 5, moves: 27, colors: 6,
          difficulty: 'hard',     designIntent: '在受限空间中制造特殊棋子并利用特效命中木箱',
          crate: [
              {row:1,col:2,layers:1},{row:1,col:5,layers:2},
              {row:4,col:1,layers:1},{row:4,col:6,layers:1},
              {row:6,col:2,layers:2},{row:6,col:5,layers:1},
          ],
        },
        // V: L24 分数 + 木箱阵（含 4 个双层）
{ level: 24, chapter: 5, isBoss: false, goalType: 'score',   targetScore: 2100, moves: 26, colors: 6,
          difficulty: 'hard',     designIntent: '在木箱分段重力条件下通过特效和连锁完成高分',
          crate: [
              {row:0,col:2,layers:1},{row:0,col:5,layers:2},
              {row:2,col:0,layers:1},{row:2,col:3,layers:2},
              {row:2,col:4,layers:2},{row:2,col:7,layers:1},
              {row:4,col:0,layers:1},{row:4,col:3,layers:1},
              {row:4,col:4,layers:1},{row:4,col:7,layers:2},
          ],
        },
        // V: L25 Boss — 拆箱（12 个木箱，含 5 个双层）
        { level: 25, chapter: 5, isBoss: true, goalType: 'crate', crateTarget: 12, moves: 24, colors: 6,
          difficulty: 'boss',     designIntent: '清除全部混合木箱，综合考察相邻消除、特效和分段重力',
          crate: [
              {row:0,col:1,layers:1},{row:0,col:4,layers:2},{row:0,col:6,layers:2},
              {row:2,col:2,layers:2},{row:2,col:5,layers:2},
              {row:4,col:1,layers:2},{row:4,col:3,layers:2},{row:4,col:6,layers:2},
              {row:5,col:2,layers:2},{row:5,col:5,layers:2},
              {row:7,col:1,layers:2},{row:7,col:6,layers:1},
          ],
        },
    ];

    // ── 运行时状态 ────────────────────────────
    private currentLevel = 0;
    private currentScore = 0;
    private currentSteps = 0;
    private scoreDoubled = false;
    /** 上一关的章节号（用于检测进入新章节） */
    private lastChapter = 0;
    /** 章节过场卡是否正在显示 */
    private chapterCardShowing = false;

    // ── 关卡运行时计数器（进关清零） ────────────
    private collectedCount: Record<string, number> = {};
    private detonatedSpecials = 0;
    private clearedIceCells = 0;  // U1: 已清除的冰格数
    private iceTutorialShown = false;  // U1: L16 冰层教学是否已展示
    private clearedCrateCells = 0;  // V: 已清除的木箱格数
    private crateTutorialShown = false;  // V: L21 木箱教学是否已展示

    // ── 引用 ──────────────────────────────────
    private board: Board | null = null;
    private whiteFrame: SpriteFrame | null = null;

    // ── UI 节点 ───────────────────────────────
    private hudNode: Node | null = null;
    private hudWidget: Widget | null = null;
    private levelLabel: Label | null = null;
    private scoreLabel: Label | null = null;
    private stepsLabel: Label | null = null;

    private resultPanel: Node | null = null;
    private resultTitle: Label | null = null;
    private resultScore: Label | null = null;
    private resultAdBtn: Node | null = null;
    private resultAdLabel: Label | null = null;
    private resultNextBtn: Node | null = null;
    private resultNextLabel: Label | null = null;
    private resultShareBtn: Node | null = null;
    private resultShareLabel: Label | null = null;
    private resultSelectBtn: Node | null = null;
    private resultSelectLabel: Label | null = null;
    /** 结算页扭蛋币提示 Label */
    private resultCoinLabel: Label | null = null;
    /** 结算页章末公仔解锁提示 Label */
    private resultMonsterLabel: Label | null = null;

    // ── H2: 分数滚动插值 ───────────────────
    /** 分数显示插值当前值 */
    private _displayScore = 0;
    /** P3: 分数滚动链计数器（新链自增使旧链自动退出） */
    private _scoreAnimToken = 0;
    /** 本次发放的扭蛋币数量（结算显示用） */
    private lastCoinReward = 0;
    /** 扭蛋币翻倍广告是否已用（本关结算期间） */
    private coinDoubled = false;
    /** 结算页扭蛋币翻倍广告按钮 */
    private resultCoinAdBtn: Node | null = null;
    private resultCoinAdLabel: Label | null = null;

    // ── 关卡选择页 ───────────────────────────────
    private levelSelectPanel: Node | null = null;
    /** 关卡按钮引用（index = levelConfigs 索引） */
    private levelSelectBtns: { node: Node; bg: Graphics; mainLabel: Label; subLabel: Label }[] = [];

    // ── 抽卡页（E2） ─────────────────────────────
    private gachaPanel: Node | null = null;
    private gachaCoinLabel: Label | null = null;
    private gachaPullBtn: Node | null = null;
    private gachaPullLabel: Label | null = null;
    private gachaAdBtn: Node | null = null;
    private gachaAdLabel: Label | null = null;
    private gachaResultNode: Node | null = null;
    private gachaResultEmoji: Label | null = null;
    private gachaResultRarity: Label | null = null;
    private gachaResultNew: Label | null = null;
    private gachaPulling = false;
    /** C: 抽卡结果光效节点 */
    private gachaGlowNode: Node | null = null;

    // ── 图鉴页（E3） ─────────────────────────────
    private collectionPanel: Node | null = null;
    private collectionCompletionLabel: Label | null = null;
    private collectionCells: { emojiLabel: Label; starLabel: Label; countLabel: Label; bgNode: Node; upgradeBtn: Node }[] = [];
    /** J1: 公仔详情弹卡节点 */
    private monsterDetailCard: Node | null = null;

    // ── 装扮页（Q1） ─────────────────────────────
    private dressupPanel: Node | null = null;
    private dressupPreviewBg: Graphics | null = null;
    private dressupPreviewEmoji: Label | null = null;
    private dressupPreviewAcc: Label | null = null;
    private dressupThemeCells: { id: number; node: Node; statusLabel: Label }[] = [];
    private dressupAccessoryCells: { id: number; node: Node; statusLabel: Label }[] = [];

    // ── 设置面板（R2） ─────────────────────────────
    private settingsPanel: Node | null = null;
    private settingsSoundCapsule: Node | null = null;
    private settingsSoundLabel: Label | null = null;
    private settingsVibrateCapsule: Node | null = null;
    private settingsVibrateLabel: Label | null = null;

    // ── 每日签到（R3） ─────────────────────────────
    private dailySignPanel: Node | null = null;
    private dailySignCells: { node: Node; bg: Graphics; dayLabel: Label; rewardLabel: Label; statusLabel: Label }[] = [];
    private dailySignClaimBtn: Node | null = null;
    private dailySignClaimLabel: Label | null = null;
    private dailySignHasShownToday = false;

    // ── A: 结算卡片动态布局引用 ───────────────────
    private resultCardG: Graphics | null = null;
    private resultShadowG: Graphics | null = null;
    private resultCardUT: UITransform | null = null;
    private resultShadowUT: UITransform | null = null;
    private resultCardNode: Node | null = null;
    private readonly resultCardW = 560;

    // ── B: 关卡选择页资源徽章 ─────────────────────
    private levelSelectCoinBadge: Label | null = null;
    private levelSelectCollectionBadge: Label | null = null;

    // ── 首页层（F0） ─────────────────────────────
    private homePanel: Node | null = null;
    private homeBgSprite: Sprite | null = null;
    // S1: 首页资源总览条
    private homeCoinBadge: Label | null = null;
    private homeCollectionBadge: Label | null = null;
    // S2: 首页「继续上次」快捷入口
    private homeContinueBtn: Node | null = null;
    private homeContinueLabel: Label | null = null;
    // S3: 首页音效/震动状态角标
    private homeSoundBadge: Label | null = null;
    private homeVibrateBadge: Label | null = null;

    private stepsPanel: Node | null = null;
    private hidingPanels: Set<Node> = new Set();
    private chapterCard: Node | null = null;
    private chapterTitleLabel: Label | null = null;
    private chapterSubtitleLabel: Label | null = null;
    private chapterBossLabel: Label | null = null;

    // ── 暂停弹层 ──
    private pauseBtn: Node | null = null;
    private pausePanel: Node | null = null;
    private pauseCard: Node | null = null;
    private pauseConfirmCard: Node | null = null;
    /** 是否在关卡中（控制暂停键可见性） */
    private _inLevel = false;

    // ── W: 局内道具系统 ─────────────────────────
    private hammerCount = 1;
    private shuffleCount = 1;
    private addStepsCount = 1;

    private boosterBar: Node | null = null;
    private hammerBtn: Node | null = null;
    private shuffleBtn: Node | null = null;
    private addStepsBtn: Node | null = null;

    private hammerLabel: Label | null = null;
    private shuffleLabel: Label | null = null;
    private addStepsLabel: Label | null = null;

    private hammerSelecting = false;
    private boosterBusy = false;
    private hammerHintLabel: Label | null = null;

    // ── X0: 广告续步限次 ─────────────────────────
    private continueAdUsed = false;
    private continueAdPending = false;
    private stepsAdBtn: Node | null = null;
    private stepsAdLabel: Label | null = null;
    /** X0: 关卡挑战 token — 每次 startLevel 递增，防止旧广告回调污染新关卡 */
    private levelRunToken = 0;

    // ── X1: 本地难度诊断 ─────────────────────────
    private levelAttemptCounts: Record<number, number> = {};
    private validMovesUsedThisRun = 0;
    private hammerUsedThisRun = false;
    private shuffleUsedThisRun = false;
    private addStepsUsedThisRun = false;
    private difficultyResultLogged = false;

    // ── 游戏背景层（章节主题色） ─────────────────
    private gameBgNode: Node | null = null;
    private gameBgG: Graphics | null = null;
    private gameBgOp: UIOpacity | null = null;

    /** 每章背景主题色（顶/底，低饱和软萌调） */
    private static readonly CHAPTER_BG_THEMES: { top: string; bottom: string }[] = [
        { top: '#FDF2F8', bottom: '#F5E8F0' }, // 第1章「初识」暖粉奶油
        { top: '#EAF5EF', bottom: '#DCEDE4' }, // 第2章「进阶」薄荷奶绿
        { top: '#F0EAF7', bottom: '#E2D8EE' }, // 第3章「终章」暮光薰衣草
        { top: '#FFF4E6', bottom: '#F5E6D3' }, // 第4章「新篇」暖橘奶油
        { top: '#F5EDE0', bottom: '#EBD9C8' }, // 第5章「拆箱」温暖木色
    ];

    /** 章末Boss首次通关赠送的公仔 monId（按章号 1/2/3 → 0兔/3鹿/5狐） */
    private static readonly CHAPTER_BOSS_MONSTER: number[] = [0, 3, 5, 4, 2];

    /** X2: 难度测试独立存储键 */
    private static readonly DIFFICULTY_TEST_KEY = 'mxmh_difficulty_test_v1';
    /** X2: 最多保留测试记录数 */
    private static readonly DIFFICULTY_TEST_MAX_RECORDS = 500;

    // ── 录屏 videoPath ─────────────────────────
    private recordedVideoPath: string | null = null;

    // ── 布局常量 ──────────────────────────────
    private readonly HUD_HEIGHT = 68;
    private readonly BANNER_HEIGHT = 120;
    private readonly HUD_SIDE_MARGIN = 20;
    /** 兜底顶部边距（所有方法都失败时用） */
    private readonly FALLBACK_TOP = 100;

    // ── 马卡龙配色 ──────────────────────────────
    private readonly COLOR_BG = new Color(0xE4, 0xD2, 0xE2);        // #E4D2E2 中心淡紫粉（渐变中心色）
    private readonly COLOR_CARD = new Color(0xFF, 0xFC, 0xF8);      // #FFFCF8 奶白
    private readonly COLOR_CARD_BORDER = new Color(0xE6, 0xD8, 0xF0); // #E6D8F0 淡紫描边
    private readonly COLOR_TEXT_MAIN = new Color(0x6B, 0x55, 0x60); // #6B5560 深可可（不变）
    private readonly COLOR_HUD_TEXT = new Color(0x4A, 0x2B, 0x6B);   // #4A2B6B 深紫（HUD 文字）
    private readonly COLOR_TITLE_WIN = new Color(0x4A, 0x2B, 0x6B); // #4A2B6B 深紫（过关标题）
    private readonly COLOR_TITLE_LOSE = new Color(0x4A, 0x2B, 0x6B); // #4A2B6B 深紫（失败标题）
    private readonly COLOR_BTN_PRIMARY = new Color(0x8B, 0x5C, 0xA7); // #8B5CA7 主色紫实心
    private readonly COLOR_BTN_AD = new Color(0xFF, 0xB3, 0x00);    // #FFB300 暖金高亮实心
    private readonly COLOR_BTN_GIVEUP = new Color(0xC9, 0xCD, 0xD4); // #C9CDD4 放弃灰（分享按钮）
    private readonly COLOR_GHOST_BORDER = new Color(0x8B, 0x5C, 0xA7); // #8B5CA7 幽灵按钮描边
    private readonly COLOR_GHOST_TEXT = new Color(0x4A, 0x2B, 0x6B);  // #4A2B6B 幽灵按钮文字
    private readonly COLOR_BTN_STROKE = new Color(0, 0, 0, 40);       // 按钮轻描边
    private readonly COLOR_HUD_BAR = new Color(0xFF, 0xFF, 0xFF, 220); // 奶白半透明
    private readonly COLOR_CHAPTER_GOLD = new Color(0xFF, 0xB3, 0x00); // #FFB300 章末 Boss 金色
    private readonly COLOR_LEVEL_LOCKED = new Color(0xD0, 0xD3, 0xD8); // #D0D3D8 灰色未解锁
    private readonly COLOR_LEVEL_LOCKED_TEXT = new Color(0x99, 0x99, 0x99); // 灰色未解锁文字
    private readonly COLOR_RARITY_R = new Color(0x6B, 0x8E, 0x23);   // R 暗黄绿
    private readonly COLOR_RARITY_SR = new Color(0x4A, 0x90, 0xD9);   // SR 蓝色
    private readonly COLOR_RARITY_SSR = new Color(0xFF, 0xB3, 0x00); // SSR 金色
    private readonly COLOR_COLLECTION_SILHOUETTE = new Color(0xCC, 0xCC, 0xCC); // 未拥有灰色剪影

    // ── 运行时读取的 Canvas 尺寸 ────────────────
    private canvasW = 720;
    private canvasH = 1280;

    // ── 计算后的边距（设计分辨率坐标系） ──────────
    private topInset = 100;
    private hudRightMargin = 20;
    private hudLeftMargin = 20;

    // ── 是否需要延迟重算 ────────────────────────
    private needRelayout = false;

    // ── 游戏圈入口 ────────────────────────────
    private gameClubEntry: GameClubEntry | null = null;

    // ══════════════════════════════════════════════════════════════════════════
    //  生命周期
    // ══════════════════════════════════════════════════════════════════════════

    onLoad(): void {
        this.whiteFrame = builtinResMgr.get<SpriteFrame>('default-sprite-splash');

        // 运行时读取 Canvas 实际尺寸
        this.readCanvasSize();

        // 计算顶部边距 & 胶囊避让
        this.calcInsets();

        // 创建游戏圈入口按钮（非微信环境自动降级跳过）
        this.gameClubEntry = new GameClubEntry(
            this.canvasW, this.canvasH, this.topInset, this.HUD_HEIGHT,
        );

        // 查找 Board 组件
        const boardNode = this.node.parent?.getChildByName('Board');
        this.board = boardNode?.getComponent(Board) ?? null;

        if (this.board) {
            this.board.setCallbacks({
                onValidSwap: () => this.onValidSwap(),
                onScoreChange: (score: number) => this.onScoreChange(score),
                onChainComplete: () => this.onChainComplete(),
                onTileEliminated: (colorId: number) => this.onTileEliminated(colorId),
                onSpecialDetonated: () => this.onSpecialDetonated(),
                onIceCleared: (row: number, col: number) => this.onIceCleared(row, col),
                onIceDamaged: (row: number, col: number, layersRemaining: number) => this.onIceDamaged(row, col, layersRemaining),
                onCrateCleared: (row: number, col: number) => this.onCrateCleared(row, col),
                onCrateDamaged: (row: number, col: number, layersRemaining: number) => this.onCrateDamaged(row, col, layersRemaining),
                onHammerResolved: (success: boolean) => this.onHammerResolved(success),
            } as BoardCallbacks);
        }

        this.createAllUI();
        this.createChapterCard();

        // 监听窗口尺寸变化（微信 onResize / 浏览器 resize）
        this.setupResizeListener();

        // 初始化录屏回调
        this.setupRecorder();

        // X2: 安装难度测试调试 API
        this.installDifficultyDebugApi();
    }

    start(): void {
        // 如果 onLoad 阶段没能拿到有效边距，延迟一帧重算
        if (this.needRelayout) {
            this.scheduleOnce(() => {
                this.calcInsets();
                this.applyLayout();
                this.needRelayout = false;
            }, 0);
        }

        this.layoutBoard();
        this.layoutBoosterBar();
        // F0: 启动先显示首页（不再直接进关卡选择页）
        this.showHomePanel();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Canvas 尺寸读取
    // ══════════════════════════════════════════════════════════════════════════

    private readCanvasSize(): void {
        const canvasUT = this.node.parent!.getComponent(UITransform);
        if (canvasUT) {
            this.canvasW = this.safeNum(canvasUT.width, 720);
            this.canvasH = this.safeNum(canvasUT.height, 1280);
        }
        console.log(`[GameManager] Canvas 尺寸: ${this.canvasW}×${this.canvasH}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  边距计算 — safeArea 为主依据，胶囊做横向避让，全程防 NaN
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 计算顶部边距和横向避让（三级策略，全程 NaN 保护）：
     *
     * 1. safeArea.top（主依据）
     *    - 微信：wx.getWindowInfo().safeArea.top 或 wx.getSystemInfoSync().safeArea.top
     *    - 浏览器：screen.safeArea 换算
     *
     * 2. 胶囊 bottom（辅助依据，仅横向避让 + 取 max）
     *    - wx.getMenuButtonBoundingClientRect() 返回有效时：
     *      topInset = max(safeArea.top, capsuleBottom) + 10
     *      hudRightMargin = canvasW - capsuleLeft + 10
     *    - 返回 undefined / 无效 → 忽略，只用 safeArea.top
     *
     * 3. 兜底：固定 100px
     */
    private calcInsets(): void {
        // ── 默认兜底值 ────────────────────────────
        let safeTop = this.FALLBACK_TOP;
        this.hudLeftMargin = this.HUD_SIDE_MARGIN;
        this.hudRightMargin = this.HUD_SIDE_MARGIN;

        // ── 1. 微信 safeArea ───────────────────────
        if (typeof wx !== 'undefined') {
            try {
                let info: any = null;
                // 优先 getWindowInfo（新版 API）
                if (wx.getWindowInfo) {
                    info = wx.getWindowInfo();
                } else if (wx.getSystemInfoSync) {
                    info = wx.getSystemInfoSync();
                }

                if (info && info.safeArea) {
                    const sa = info.safeArea;
                    // safeArea.top 是逻辑像素，换算到设计分辨率
                    const winW = this.safeNum(info.windowWidth, 0);
                    if (winW > 0) {
                        const scale = this.canvasW / winW;
                        safeTop = this.safeNum(sa.top, 0) * scale;
                        console.log(
                            `[GameManager] 微信 safeArea: top=${sa.top}, windowWidth=${winW}, ` +
                            `scale=${scale.toFixed(3)}, safeTop=${safeTop.toFixed(1)}`,
                        );
                    }
                }
            } catch (e) {
                console.warn('[GameManager] wx safeArea 获取失败', e);
            }

            // ── 2. 微信胶囊按钮（仅做横向避让 + 取 max） ──────
            const capsule = this.getValidCapsuleRect();
            if (capsule) {
                // 胶囊 bottom → 设计坐标
                const capsuleBottom = capsule.bottom;
                // topInset = max(safeArea.top, 胶囊 bottom) + 10
                safeTop = Math.max(safeTop, capsuleBottom) + 10;

                // 胶囊左边缘 → HUD 右边距
                this.hudRightMargin = Math.max(
                    this.HUD_SIDE_MARGIN,
                    this.canvasW - capsule.left + 10,
                );

                console.log(
                    `[GameManager] 胶囊有效: bottom=${capsule.bottom.toFixed(1)}, ` +
                    `left=${capsule.left.toFixed(1)}, ` +
                    `topInset=${safeTop.toFixed(1)}, ` +
                    `hudRightMargin=${this.hudRightMargin.toFixed(1)}`,
                );
            } else {
                safeTop += 10;
                console.log('[GameManager] 胶囊无效，仅用 safeArea + 10');
            }
        } else {
            // ── 1b. 浏览器 safeArea ──────────────────
            try {
                const sa = screen.safeArea;
                if (sa && sa.height > 0 && sa.width > 0) {
                    const winSize = screen.windowSize;
                    if (winSize && winSize.height > 0) {
                        const topPx = winSize.height - sa.y - sa.height;
                        const scaleY = ccView.getScaleY();
                        if (scaleY > 0) {
                            safeTop = Math.max(0, topPx / scaleY) + 10;
                            console.log(`[GameManager] 浏览器 safeArea: topPx=${topPx}, safeTop=${safeTop.toFixed(1)}`);
                        }
                    }
                }
            } catch (e) {
                console.warn('[GameManager] screen.safeArea 不可用', e);
            }
        }

        // ── 3. 最终 NaN 保护 ──────────────────────
        this.topInset = this.safeNum(safeTop, this.FALLBACK_TOP);
        this.hudLeftMargin = this.safeNum(this.hudLeftMargin, this.HUD_SIDE_MARGIN);
        this.hudRightMargin = this.safeNum(this.hudRightMargin, this.HUD_SIDE_MARGIN);

        // 确保非负
        this.topInset = Math.max(10, this.topInset);
        this.hudLeftMargin = Math.max(10, this.hudLeftMargin);
        this.hudRightMargin = Math.max(10, this.hudRightMargin);

        console.log(
            `[GameManager] 边距最终值: topInset=${this.topInset.toFixed(1)} ` +
            `(valid=${this.isValidNum(this.topInset)}), ` +
            `hudLeftMargin=${this.hudLeftMargin.toFixed(1)}, ` +
            `hudRightMargin=${this.hudRightMargin.toFixed(1)}`,
        );
    }

    /**
     * 获取有效的胶囊按钮矩形，无效时返回 null。
     * 严格检查 rect 存在且 bottom/top/left/right 是有效数字。
     */
    private getValidCapsuleRect(): { top: number; bottom: number; left: number; right: number } | null {
        if (typeof wx === 'undefined' || !wx.getMenuButtonBoundingClientRect) {
            return null;
        }

        try {
            const rect = wx.getMenuButtonBoundingClientRect();
            if (!rect) return null;

            const top = this.safeNum(rect.top, NaN);
            const bottom = this.safeNum(rect.bottom, NaN);
            const left = this.safeNum(rect.left, NaN);
            const right = this.safeNum(rect.right, NaN);

            // 任一字段无效 → 整体视为无效
            if (!this.isValidNum(top) || !this.isValidNum(bottom) ||
                !this.isValidNum(left) || !this.isValidNum(right)) {
                console.warn(
                    `[GameManager] 胶囊矩形无效: top=${rect.top}, bottom=${rect.bottom}, ` +
                    `left=${rect.left}, right=${rect.right}`,
                );
                return null;
            }

            // 换算到设计分辨率坐标系
            let winW = 0;
            try {
                if (wx.getWindowInfo) {
                    winW = wx.getWindowInfo().windowWidth;
                } else if (wx.getSystemInfoSync) {
                    winW = wx.getSystemInfoSync().windowWidth;
                }
            } catch (e) {
                // ignore
            }

            winW = this.safeNum(winW, 0);
            if (winW <= 0) {
                console.warn('[GameManager] 无法获取 windowWidth，胶囊换算失败');
                return null;
            }

            const scale = this.canvasW / winW;
            return {
                top: top * scale,
                bottom: bottom * scale,
                left: left * scale,
                right: right * scale,
            };
        } catch (e) {
            console.warn('[GameManager] getMenuButtonBoundingClientRect 调用异常', e);
            return null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  NaN 安全工具
    // ══════════════════════════════════════════════════════════════════════════

    /** 判断是否是有效有限数字 */
    private isValidNum(v: number): boolean {
        return typeof v === 'number' && !isNaN(v) && isFinite(v);
    }

    /** 如果 v 是有效数字返回 v，否则返回 fallback */
    private safeNum(v: number, fallback: number): number {
        return this.isValidNum(v) ? v : fallback;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  棋盘布局（三段式：顶部 HUD / 中部棋盘 / 底部 Banner）
    // ══════════════════════════════════════════════════════════════════════════

    private layoutBoard(): void {
        const boardNode = this.node.parent?.getChildByName('Board');
        if (!boardNode) return;

        // 全程 NaN 保护
        const topInset = this.safeNum(this.topInset, this.FALLBACK_TOP);
        const canvasH = this.safeNum(this.canvasH, 1280);
        const hudHeight = this.safeNum(this.HUD_HEIGHT, 68);

        // ── 1. 取 HUD 实测底边（局部坐标系）──
        let hudCenterY: number;
        if (this.hudNode && this.hudNode.isValid) {
            if (this.hudWidget) {
                this.hudWidget.top = this.safeNum(topInset + 12 + hudHeight, 112 + hudHeight);
                this.hudWidget.updateAlignment();
            }
            hudCenterY = this.safeNum(this.hudNode.position.y, canvasH / 2 - topInset - 12 - hudHeight / 2);
        } else {
            hudCenterY = canvasH / 2 - topInset - 12 - hudHeight / 2;
        }
        const hudBottom = hudCenterY - hudHeight / 2;

        // ── 2. 可用垂直区间（局部坐标系，Canvas 中心为原点）──
        // freeTop = HUD 底边 − 顶部间距 24
        const freeTop = this.safeNum(hudBottom - 24, canvasH / 2 - topInset - hudHeight - 24);
        // freeBottom = 可视区底边 + 底部安全边距（约屏高 7%，含 Banner 预留）
        const bottomSafeMargin = Math.round(canvasH * 0.07);
        const freeBottom = this.safeNum(-(canvasH / 2) + bottomSafeMargin, -(canvasH / 2) + 90);

        // ── 3. 棋盘高度 ──
        const { ROWS, TILE_SIZE, GAP } = Board;
        const boardHeight = ROWS * TILE_SIZE + (ROWS - 1) * GAP;

        // ── 4. 棋盘垂直中心 = 可用区中点 + 略偏上 8% ──
        const availableH = freeTop - freeBottom;
        const midY = (freeTop + freeBottom) / 2;
        let boardCenterY = this.safeNum(midY + (freeTop - freeBottom) * 0.08, 0);

        // ── 5. 夹取保护 ──
        const halfBoard = boardHeight / 2;
        let boardTopLocal = boardCenterY + halfBoard;
        let boardBottomLocal = boardCenterY - halfBoard;

        // 棋盘太高放不下 → 按比例缩小
        if (boardHeight > availableH && availableH > 0) {
            const scale = availableH / boardHeight;
            const newHalf = halfBoard * scale;
            boardTopLocal = midY + newHalf;
            boardBottomLocal = midY - newHalf;
            boardCenterY = midY;
            console.warn(
                `[GameManager] 棋盘高 ${boardHeight} > 可用区高 ${availableH.toFixed(1)}，缩放 ${scale.toFixed(3)}`,
            );
        } else {
            // 顶边超 freeTop → 下移
            if (boardTopLocal > freeTop) {
                boardCenterY -= (boardTopLocal - freeTop);
                boardTopLocal = freeTop;
                boardBottomLocal = boardCenterY - halfBoard;
            }
            // 底边低于 freeBottom → 上移
            if (boardBottomLocal < freeBottom) {
                boardCenterY += (freeBottom - boardBottomLocal);
                boardBottomLocal = freeBottom;
                boardTopLocal = boardCenterY + halfBoard;
            }
        }

        // NaN 兜底
        if (!this.isValidNum(boardCenterY)) {
            console.error('[GameManager] boardCenterY 是 NaN！使用兜底值 0');
            boardNode.setPosition(0, 0, 0);
            return;
        }

        boardNode.setPosition(0, boardCenterY, 0);

        console.log(
            `[GameManager] 棋盘布局: boardCenterY=${boardCenterY.toFixed(1)} ` +
            `hudBottom=${hudBottom.toFixed(1)}, freeTop=${freeTop.toFixed(1)}, ` +
            `freeBottom=${freeBottom.toFixed(1)}, availableH=${availableH.toFixed(1)}, ` +
            `boardHeight=${boardHeight}, boardTop=${boardTopLocal.toFixed(1)}, ` +
            `boardBottom=${boardBottomLocal.toFixed(1)}`,
        );

        // ── 诊断 dump ──
        this.dumpBoardDiagnostics(boardNode);
    }

    /** 棋盘诊断：根节点 BBox + 两角格 worldPosition + 可视区 */
    private dumpBoardDiagnostics(boardNode: Node): void {
        const boardUT = boardNode.getComponent(UITransform);
        const boardWP = boardNode.worldPosition;
        const boardBB = boardUT ? boardUT.getBoundingBoxToWorld() : null;

        console.log(
            `[BOARD-DUMP] Root: name=${boardNode.name} active=${boardNode.active} ` +
            `size=(${this.safeNum(boardUT?.width, -1).toFixed(0)}×${this.safeNum(boardUT?.height, -1).toFixed(0)}) ` +
            `anchor=(${boardUT?.anchorX ?? '?'},${boardUT?.anchorY ?? '?'}) ` +
            `localPos=(${boardNode.position.x.toFixed(1)},${boardNode.position.y.toFixed(1)}) ` +
            `worldPos=(${boardWP.x.toFixed(1)},${boardWP.y.toFixed(1)}) ` +
            `layer=${boardNode.layer}`,
        );
        if (boardBB) {
            console.log(
                `[BOARD-DUMP] BBox: x=${boardBB.x.toFixed(1)} y=${boardBB.y.toFixed(1)} ` +
                `w=${boardBB.width.toFixed(1)} h=${boardBB.height.toFixed(1)}`,
            );
        }

        // Canvas 根节点 BBox
        const canvasNode = this.node.parent;
        if (canvasNode) {
            const canvasUT = canvasNode.getComponent(UITransform);
            if (canvasUT) {
                const canvasBB = canvasUT.getBoundingBoxToWorld();
                console.log(
                    `[BOARD-DUMP] Canvas: size=(${canvasUT.width.toFixed(0)}×${canvasUT.height.toFixed(0)}) ` +
                    `BBox: x=${canvasBB.x.toFixed(1)} y=${canvasBB.y.toFixed(1)} ` +
                    `w=${canvasBB.width.toFixed(1)} h=${canvasBB.height.toFixed(1)}`,
                );
            }
        }

        // 可视区
        const visibleSize = view.getVisibleSize();
        console.log(
            `[BOARD-DUMP] VisibleSize: ${visibleSize.width.toFixed(1)}×${visibleSize.height.toFixed(1)}`,
        );

        // 两角格 worldPosition
        const tile00 = boardNode.getChildByName('Tile_0_0');
        const tile77 = boardNode.getChildByName('Tile_7_7');
        if (tile00) {
            const wp = tile00.worldPosition;
            console.log(`[BOARD-DUMP] Tile[0,0]: worldPos=(${wp.x.toFixed(1)},${wp.y.toFixed(1)}) active=${tile00.active}`);
        } else {
            console.log('[BOARD-DUMP] Tile[0,0]: not found');
        }
        if (tile77) {
            const wp = tile77.worldPosition;
            console.log(`[BOARD-DUMP] Tile[7,7]: worldPos=(${wp.x.toFixed(1)},${wp.y.toFixed(1)}) active=${tile77.active}`);
        } else {
            console.log('[BOARD-DUMP] Tile[7,7]: not found');
        }
    }

    /** 重新应用所有布局（延迟重算时调用） */
    private applyLayout(): void {
        this.readCanvasSize();
        this.calcInsets();

        // 更新 HUD Widget（top + horizontalCenter）
        if (this.hudWidget) {
            this.hudWidget.top = this.safeNum(this.topInset + 12 + this.HUD_HEIGHT, 112 + this.HUD_HEIGHT);
            this.hudWidget.left = 0;
            this.hudWidget.right = 0;
            this.hudWidget.isAlignLeft = false;
            this.hudWidget.isAlignRight = false;
            this.hudWidget.isAlignHorizontalCenter = true;
            this.hudWidget.horizontalCenter = 0;
            this.hudWidget.updateAlignment();
        }

        // 重画 HUD 药丸背景（适配新宽度）
        this.scheduleOnce(() => this.redrawHudBar(), 0);

        // 重新布局棋盘
        this.layoutBoard();
        this.layoutBoosterBar();

        // 重新定位游戏圈按钮
        this.gameClubEntry?.reposition(
            this.canvasW, this.canvasH, this.topInset, this.HUD_HEIGHT,
        );

        console.log('[GameManager] 延迟重算完成');
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  resize 监听
    // ══════════════════════════════════════════════════════════════════════════

    private setupResizeListener(): void {
        // 微信 onResize
        if (typeof wx !== 'undefined' && wx.onWindowResize) {
            wx.onWindowResize(() => {
                this.scheduleOnce(() => this.applyLayout(), 0);
            });
        }

        // Cocos screen resize
        try {
            screen.on('window-resize', () => {
                this.scheduleOnce(() => this.applyLayout(), 0);
            });
        } catch (e) {
            // 某些平台不支持
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  关卡管理
    // ══════════════════════════════════════════════════════════════════════════

    private startLevel(levelIndex: number): void {
        // 边界保护：越界时回到第一关
        if (levelIndex < 0 || levelIndex >= this.levelConfigs.length) {
            console.warn(`[GameManager] 关卡索引越界: ${levelIndex}，回到第一关`);
            levelIndex = 0;
        }

        this.currentLevel = levelIndex;
        const config = this.levelConfigs[levelIndex];
        this.currentScore = 0;
        this.currentSteps = this.safeNum(config.moves, 20);
        this.scoreDoubled = false;

        // 进关清零计数器
        this.collectedCount = {};
        this.detonatedSpecials = 0;
        this.clearedIceCells = 0;  // U1: 清零冰格计数
        this.clearedCrateCells = 0;  // V: 清零木箱格计数

        // W: 重置局内道具
        this.hammerCount = 1;
        this.shuffleCount = 1;
        this.addStepsCount = 1;
        this.hammerSelecting = false;
        this.boosterBusy = false;
        this.board?.cancelHammerMode();

        // X0: 重置广告续步状态 + 关卡 token
        this.continueAdUsed = false;
        this.continueAdPending = false;
        this.levelRunToken++;

        // X1: 重置难度诊断字段
        this.levelAttemptCounts[config.level] =
            (this.levelAttemptCounts[config.level] ?? 0) + 1;
        this.validMovesUsedThisRun = 0;
        this.hammerUsedThisRun = false;
        this.shuffleUsedThisRun = false;
        this.addStepsUsedThisRun = false;
        this.difficultyResultLogged = false;

        this.hidePanel(this.resultPanel);
        this.hidePanel(this.stepsPanel);
        this.hidePanel(this.pausePanel);

        // 游戏进行中 → 隐藏游戏圈按钮
        this.gameClubEntry?.hide();

        this.board?.setLevel(levelIndex);  // C0: 设置关卡号（L1=0 触发手势引导）
        this.board?.resetBoard(config.colors, config.ice ?? [], config.crate ?? []);  // V: 传入冰层+木箱配置
        // setBusy(false) 移到章节卡逻辑末尾（避免过场卡期间棋盘可交互）

        this.updateHUD();

        // Fix 1.1: 延迟重算布局
        this.scheduleOnce(() => {
            this.layoutBoard();
            this.layoutBoosterBar();
            this.updateBoosterUI();
            this.updateBoosterBarVisible();
        }, 0.1);

        // 开始录屏（抖音环境才生效，非抖音降级跳过）
        // X3.1: 自动测试期间不启动录屏
        if (!this._autoTestRunning) {
            RecorderManager.getInstance().start(300);
        }

        console.log(
            `[GameManager] ── L${config.level} ` +
            `difficulty=${config.difficulty} ` +
            `目标=${config.goalType} ` +
            `${config.moves}步 ${config.colors}色 ` +
            `意图=${config.designIntent} ──`,
        );

        // ★ 章节主题色：按 config.chapter 切换背景（首次或切章时淡变，同章不重复）
        const newChapter = this.safeNum(config.chapter, 1);
        if (this.lastChapter === 0 || this.lastChapter !== newChapter) {
            this.applyChapterTheme(newChapter);
        }

        // ★ 章节过场卡：进入新章首关时弹一次
        if (this.lastChapter !== 0 && this.lastChapter !== newChapter) {
            this.showChapterCard(newChapter, config.isBoss);
        } else {
            // 首次进入或同章切关：直接开始
            this.lastChapter = newChapter;
            this.board?.setBusy(false);
        }

        // 标记进入关卡，更新暂停键可见性
        this._inLevel = true;
        this.updatePauseBtnVisible();

        // U1: L16 首次进入时显示冰层教学提示
        if (levelIndex === 15 && !this.iceTutorialShown) {
            this.iceTutorialShown = true;
            this.scheduleOnce(() => {
                this.showIceTutorial();
            }, 2.0);
        }

        // V: L21 首次进入时显示木箱教学提示
        if (levelIndex === 20 && !this.crateTutorialShown) {
            this.crateTutorialShown = true;
            this.scheduleOnce(() => {
                this.showCrateTutorial();
            }, 2.0);
        }
    }

    /** U1: 显示冰层教学提示（短暂弹层） */
    private showIceTutorial(): void {
        const tutorialNode = new Node('IceTutorial');
        tutorialNode.parent = this.node;

        const ut = tutorialNode.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        ut.setContentSize(pw, 80);

        const label = tutorialNode.addComponent(Label);
        label.string = '🧊 消除冰层覆盖的萌宠即可破冰，双层冰需要命中两次！';
        label.fontSize = 24;
        label.lineHeight = 28;
        label.color = new Color(0x33, 0x66, 0xAA);
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;

        tutorialNode.setPosition(0, this.safeNum(this.canvasH, 1280) * 0.3, 0);

        const op = tutorialNode.addComponent(UIOpacity);
        op.opacity = 0;

        tween(op)
            .to(0.3, { opacity: 255 })
            .delay(3.0)
            .to(0.5, { opacity: 0 })
            .call(() => {
                if (tutorialNode && tutorialNode.isValid) tutorialNode.destroy();
            })
            .start();
    }

    /** V: 显示木箱教学提示（短暂弹层） */
    private showCrateTutorial(): void {
        const tutorialNode = new Node('CrateTutorial');
        tutorialNode.parent = this.node;

        const ut = tutorialNode.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        ut.setContentSize(pw, 80);

        const label = tutorialNode.addComponent(Label);
        label.string = '📦 木箱会挡住萌宠下落，消除旁边的萌宠或用特效命中即可拆箱！';
        label.fontSize = 24;
        label.lineHeight = 28;
        label.color = new Color(0x6B, 0x42, 0x1F);
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;

        tutorialNode.setPosition(0, this.safeNum(this.canvasH, 1280) * 0.3, 0);

        const op = tutorialNode.addComponent(UIOpacity);
        op.opacity = 0;

        tween(op)
            .to(0.3, { opacity: 255 })
            .delay(3.0)
            .to(0.5, { opacity: 0 })
            .call(() => {
                if (tutorialNode && tutorialNode.isValid) tutorialNode.destroy();
            })
            .start();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Board 回调
    // ══════════════════════════════════════════════════════════════════════════

    private onValidSwap(): void {
        this.currentSteps = Math.max(0, this.currentSteps - 1);
        this.validMovesUsedThisRun++;
        this.updateHUD();
        console.log(`[GameManager] 有效交换，剩余步数: ${this.currentSteps}`);
    }

    private onScoreChange(score: number): void {
        const newScore = this.safeNum(score, 0);
        const oldScore = this.safeNum(this.currentScore, 0);
        this.currentScore = newScore;

        // ★ H2: 分数 lerp 滚动（0.3s quadOut）+ scale 弹动
        if (this.scoreLabel && newScore !== oldScore && isFinite(oldScore) && isFinite(newScore)) {
            // ★ P3: 从当前显示值续接，不硬重置起点；用计数器取消旧链
            const startVal = this._displayScore;
            const endVal = newScore;
            const duration = 0.3;
            const token = ++this._scoreAnimToken;

            // 用 scheduleOnce 模拟 lerp（每帧更新 label.string）
            const startTime = Date.now();
            const updateLabel = () => {
                if (token !== this._scoreAnimToken) return; // 被新链取代
                if (!this.scoreLabel || !this.scoreLabel.isValid) { return; }
                const elapsed = (Date.now() - startTime) / 1000;
                const t = Math.min(elapsed / duration, 1);
                // quadOut: t*(2-t)
                const eased = t * (2 - t);
                this._displayScore = Math.round(startVal + (endVal - startVal) * eased);
                const config = this.levelConfigs[this.currentLevel];
                this.scoreLabel.string = this.getGoalHudTextWithScore(config, this._displayScore);

                if (t >= 1) {
                    this._displayScore = endVal;
                    // 最终确保显示正确
                    this.updateHUD();
                    return;
                }
                this.scheduleOnce(updateLabel, 0);
            };
            updateLabel();

            // ★ H2: scale 1→1.15→1 轻弹（复用现有 punch 思路，幅度更柔）
            this.scoreLabel.node.setScale(1, 1, 1);
            tween(this.scoreLabel.node)
                .to(0.1, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'quadOut' })
                .to(0.1, { scale: new Vec3(1, 1, 1) })
                .start();
        } else {
            // NaN 直接显示目标值不滚动
            this._displayScore = newScore;
            this.updateHUD();
        }
    }

    private onChainComplete(): void {
        this.evaluateLevelAfterBoardStable();
    }

    /** W: 棋盘稳定后的统一目标判定（普通交换连锁结束 & 锤子道具稳定后均调用） */
    private evaluateLevelAfterBoardStable(): void {
        const config = this.levelConfigs[this.currentLevel];

        // 防重复结算
        if (this.resultPanel?.active || this.stepsPanel?.active) return;

        // ★ 先判过关，后判步数耗尽（避免最后一步刚好达标却误判失败）
        if (this.isGoalReached(config)) {
            console.log(`[GameManager] ★ 过关达成! goalType=${config.goalType}，剩余步数 ${this.currentSteps}`);
            // ★ 先回 IDLE 撤棋盘输入拦截，再弹面板（禁止在 CHAINING/LOCKED 下弹面板）
            this.board?.setBusy(false);
            this.showResultPanel(true);
        } else if (this.currentSteps <= 0) {
            console.log(`[GameManager] ★ 步数耗尽: ${this.currentSteps}，未达成目标`);
            // ★ 同上：先回 IDLE 再弹面板
            this.board?.setBusy(false);
            this.showStepsPanel();
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  关卡目标判定 & 计数器
    // ══════════════════════════════════════════════════════════════════════════

    /** 判定当前是否已达成关卡目标 */
    private isGoalReached(cfg: LevelConfig): boolean {
        switch (cfg.goalType) {
            case 'score':
                return this.currentScore >= this.safeNum(cfg.targetScore, Infinity);
            case 'collect': {
                const colors = Array.isArray(cfg.goalColor) ? cfg.goalColor : [cfg.goalColor!];
                const counts = Array.isArray(cfg.goalCount) ? cfg.goalCount : [cfg.goalCount!];
                for (let i = 0; i < colors.length; i++) {
                    const need = this.safeNum(counts[i], 0);
                    const have = this.collectedCount[colors[i]] ?? 0;
                    if (have < need) return false;
                }
                return true;
            }
            case 'special':
                return this.detonatedSpecials >= this.safeNum(cfg.specialCount, Infinity);
            case 'ice':
                return this.clearedIceCells >= this.safeNum(cfg.iceTarget, Infinity);
            case 'crate':
                return this.clearedCrateCells >= this.safeNum(cfg.crateTarget, Infinity);
            default:
                return false;
        }
    }

    /** Board 回调：元素被消除 → 按颜色计数 */
    private onTileEliminated(colorId: number): void {
        // colorId → colorKey 反查
        const key = Object.keys(COLOR_KEY_MAP).find(k => COLOR_KEY_MAP[k] === colorId);
        if (key) {
            this.collectedCount[key] = (this.collectedCount[key] ?? 0) + 1;
            this.updateHUD();
        }
    }

    /** Board 回调：特效块被引爆 → 计数 */
    private onSpecialDetonated(): void {
        this.detonatedSpecials++;
        this.updateHUD();
        console.log(`[GameManager] 特效引爆计数: ${this.detonatedSpecials}`);
    }

    /** U1: Board 回调 — 冰层完全清除 */
    private onIceCleared(row: number, col: number): void {
        this.clearedIceCells++;
        this.updateHUD();
        console.log(`[GameManager] 🧊 冰格清除 (${row},${col}) → 累计 ${this.clearedIceCells}`);
    }

    /** U1: Board 回调 — 冰层受损（仍有残余） */
    private onIceDamaged(row: number, col: number, layersRemaining: number): void {
        console.log(`[GameManager] 🧊 冰格受损 (${row},${col}) → 剩余 ${layersRemaining} 层`);
    }

    /** V: Board 回调 — 木箱完全清除 */
    private onCrateCleared(row: number, col: number): void {
        this.clearedCrateCells++;
        this.updateHUD();
        console.log(`[GameManager] 📦 木箱清除 (${row},${col}) → 累计 ${this.clearedCrateCells}`);
    }

    /** V: Board 回调 — 木箱受损（仍有残余） */
    private onCrateDamaged(row: number, col: number, layersRemaining: number): void {
        console.log(`[GameManager] 📦 木箱受损 (${row},${col}) → 剩余 ${layersRemaining} 层`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  HUD
    // ══════════════════════════════════════════════════════════════════════════

    private updateHUD(): void {
        const config = this.levelConfigs[this.currentLevel];
        if (!config) return;
        // ★ 章节进度显示："🏆 第X章 · n/5"
        const chapter = this.safeNum(config.chapter, 1);
        const progress = this.getChapterProgress(this.currentLevel);
        this.levelLabel!.string = `🏆 第${chapter}章 · ${progress}/5`;
        this.scoreLabel!.string = this.getGoalHudText(config);
        this.stepsLabel!.string = `👣 ${this.currentSteps}`;
    }

    /** 计算某关在本章内的序号（1~5），读 LevelConfig.chapter 判断 */
    private getChapterProgress(levelIndex: number): number {
        if (levelIndex < 0 || levelIndex >= this.levelConfigs.length) return 1;
        const targetChapter = this.safeNum(this.levelConfigs[levelIndex].chapter, 1);
        let count = 0;
        for (let i = 0; i <= levelIndex; i++) {
            if (this.safeNum(this.levelConfigs[i].chapter, 1) === targetChapter) {
                count++;
            }
        }
        return this.safeNum(count, 1);
    }

    /** 章节副标题 */
    private getChapterSubtitle(chapter: number): string {
        const subtitles = ['', '初识 · 甜甜的开始', '进阶 · 越消越上头', '终章 · 收集控の狂欢', '新篇 · 冰层大冒险', '拆箱 · 拆开惊喜'];
        const idx = this.safeNum(chapter, 1);
        return subtitles[idx] ?? `第${idx}章`;
    }

    /** 根据 goalType 生成 HUD 中间段的目标进度文本 */
    private getGoalHudText(cfg: LevelConfig): string {
        return this.getGoalHudTextWithScore(cfg, this.currentScore);
    }

    /** H2: 用指定分数值生成 HUD 文本（供滚动插值使用） */
    private getGoalHudTextWithScore(cfg: LevelConfig, displayScore: number): string {
        const safeScore = this.safeNum(displayScore, 0);
        switch (cfg.goalType) {
            case 'score':
                return `🎯 ${safeScore}/${this.safeNum(cfg.targetScore, 0)}`;
            case 'collect': {
                const colors = Array.isArray(cfg.goalColor) ? cfg.goalColor : [cfg.goalColor!];
                const counts = Array.isArray(cfg.goalCount) ? cfg.goalCount : [cfg.goalCount!];
                const parts = colors.map((key, i) => {
                    const id = COLOR_KEY_MAP[key] ?? 0;
                    const emoji = COLOR_EMOJI_MAP[id] ?? '?';
                    const have = this.collectedCount[key] ?? 0;
                    const need = this.safeNum(counts[i], 0);
                    return `${emoji}${have}/${need}`;
                });
                return `🎯 ${parts.join(' ')}`;
            }
            case 'special':
                return `💥 ${this.detonatedSpecials}/${this.safeNum(cfg.specialCount, 0)}`;
            case 'ice':
                return `🧊 ${this.clearedIceCells}/${this.safeNum(cfg.iceTarget, 0)}`;
            case 'crate':
                return `📦 ${this.clearedCrateCells}/${this.safeNum(cfg.crateTarget, 0)}`;
            default:
                return `🎯 ${safeScore}`;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  弹层 — 结算
    // ══════════════════════════════════════════════════════════════════════════

    private showResultPanel(isWin: boolean): void {
        if (!this.resultPanel) return;

        // 确保与暂停弹层互斥
        this.hidePanel(this.pausePanel);

        // 停止录屏（onStop 会拿到 videoPath）
        // X3.1: 自动测试期间未启动录屏，也跳过停止
        if (!this._autoTestRunning) {
            RecorderManager.getInstance().stop();
        }

        this.showPanel(this.resultPanel, true);

        // 结算页 → 显示游戏圈按钮（X3.1: 自动测试期间跳过）
        if (!this._autoTestRunning) {
            this.gameClubEntry?.show();
        }

        this.resultTitle!.string = isWin ? '过关 🎉' : '再试一次 😵';
        this.resultTitle!.color = isWin ? this.COLOR_TITLE_WIN.clone() : this.COLOR_TITLE_LOSE.clone();
        this.resultScore!.string = this.getResultScoreText(this.levelConfigs[this.currentLevel]);

        // ★ Boss 关过关：额外庆祝（X3.1: 自动测试期间跳过粒子）
        const config = this.levelConfigs[this.currentLevel];
        if (isWin && config.isBoss && !this._autoTestRunning) {
            const chapter = this.safeNum(config.chapter, 1);
            const chapterClearTexts = [
                '',
                '第1章 通关！萌盒+1',
                '第2章 通关！',
                '第3章 通关！',
                '🎉 第4章 通关！萌力全开',
                '🎉 第5章 通关！拆箱大师',
            ];
            const clearText = chapterClearTexts[chapter] ?? `第${chapter}章 完成！`;
            this.resultScore!.string = `${clearText}\n` + this.getResultScoreText(config);
            this.spawnBossCelebration();
        }

        this.scoreDoubled = false;
        this.coinDoubled = false;
        this.resultAdBtn!.getComponent(Button)!.interactable = true;
        this.resultAdLabel!.string = '▶  看广告·得分翻倍';

        // E5: 扭蛋币翻倍按钮仅在过关且 lastCoinReward > 0 时显示
        if (this.resultCoinAdBtn) {
            const showCoinAd = isWin && this.safeNum(this.lastCoinReward, 0) > 0;
            this.resultCoinAdBtn.active = showCoinAd;
            this.resultCoinAdBtn.getComponent(Button)!.interactable = showCoinAd && !this.coinDoubled;
        }
        if (this.resultCoinAdLabel) {
            this.resultCoinAdLabel.string = '看广告·扭蛋币翻倍';
        }

        if (isWin) {
            if (this.currentLevel >= this.levelConfigs.length - 1) {
                this.resultNextLabel!.string = '全部通关';
            } else {
                this.resultNextLabel!.string = '下一关';
            }
        } else {
            this.resultNextLabel!.string = '重玩';
        }

        if (isWin) {
            this.logDifficultyResult(true);

            // X3.1: 自动测试模式 — 跳过存档、发币、公仔解锁、音效和震动
            if (this._autoTestRunning) {
                this.lastCoinReward = 0;
                if (this.resultCoinLabel) this.resultCoinLabel.node.active = false;
                if (this.resultMonsterLabel) this.resultMonsterLabel.node.active = false;
                if (this.resultCoinAdBtn) this.resultCoinAdBtn.active = false;
                console.log('[AutoTest] 测试模式：跳过存档、发币和公仔解锁');
            } else {
                AudioManager.inst?.playWin();
                VibrateManager.inst?.long();
                // Boss 关额外震动
                if (config.isBoss) VibrateManager.inst?.heavy();

                // ★ 章末Boss首次通关：解锁公仔（必须在 markCleared 之前判断 isCleared）
                let unlockedMonId = -1;
                if (config.isBoss) {
                    const levelNum = this.safeNum(config.level, this.currentLevel + 1);
                    const isFirstClear = !SaveManager.inst.isCleared(levelNum);
                    if (isFirstClear) {
                        const chapter = this.safeNum(config.chapter, 1);
                        // 章号 → monId 映射（越界回退 -1 不赠送）
                        if (chapter >= 1 && chapter <= GameManager.CHAPTER_BOSS_MONSTER.length) {
                            unlockedMonId = GameManager.CHAPTER_BOSS_MONSTER[chapter - 1];
                            // monId 范围防护 0-5
                            if (unlockedMonId < 0 || unlockedMonId > 5) unlockedMonId = -1;
                        }
                        if (unlockedMonId >= 0) {
                            try {
                                SaveManager.inst.addMonster(unlockedMonId);
                                console.log(`[GameManager] ★ 章末Boss首次通关 → 解锁公仔 monId=${unlockedMonId} (${COLOR_EMOJI_MAP[unlockedMonId] ?? '?'})`);
                                // ★ H3: 解锁公仔上扬小音阶（复用 combo3→combo5，无文件静默）
                                try {
                                    AudioManager.inst?.playCombo(3);
                                    this.scheduleOnce(() => { try { AudioManager.inst?.playCombo(5); } catch (_) { /* ignore */ } }, 0.12);
                                } catch (e) { /* ignore */ }
                            } catch (e) {
                                console.warn('[GameManager] addMonster 异常:', e);
                                unlockedMonId = -1;
                            }
                        }
                    }
                }

                // D1: 过关写入存档（level 号从 LevelConfig.level 取，1~15）
                SaveManager.inst.markCleared(this.safeNum(config.level, this.currentLevel + 1), this.currentScore);
                // E1: 过关发放扭蛋币（普通关 +10、Boss 关 +30）
                const coinReward = config.isBoss ? 30 : 10;
                this.lastCoinReward = this.safeNum(coinReward, 10);
                SaveManager.inst.addCoins(this.lastCoinReward);
                // 结算页显示扭蛋币提示
                if (this.resultCoinLabel) {
                    this.resultCoinLabel.string = `+${this.lastCoinReward} 🎲 扭蛋币`;
                    this.resultCoinLabel.node.active = true;
                }
                // ★ 章末公仔解锁提示 + backOut 弹入动画
                if (this.resultMonsterLabel) {
                    if (unlockedMonId >= 0) {
                        const emoji = COLOR_EMOJI_MAP[unlockedMonId] ?? '?';
                        this.resultMonsterLabel.string = `🏅 第${this.safeNum(config.chapter, 1)}章通关 · 解锁 ${emoji}`;
                        this.resultMonsterLabel.fontSize = 36;
                        this.resultMonsterLabel.node.active = true;
                        // backOut 弹入（复用章节卡同款缓动）
                        Tween.stopAllByTarget(this.resultMonsterLabel.node);
                        this.resultMonsterLabel.node.setScale(0, 0, 1);
                        tween(this.resultMonsterLabel.node)
                            .to(0.3, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'backOut' })
                            .to(0.1, { scale: new Vec3(1, 1, 1) })
                            .start();
                    } else {
                        this.resultMonsterLabel.node.active = false;
                    }
                }
            }
        } else {
            this.logDifficultyResult(false);

            // X3.1: 自动测试模式 — 跳过音效和震动
            if (!this._autoTestRunning) {
                AudioManager.inst?.playLose();
                VibrateManager.inst?.long();
            }
            // 失败不发币，隐藏提示
            this.lastCoinReward = 0;
            if (this.resultCoinLabel) {
                this.resultCoinLabel.node.active = false;
            }
            // 失败不显示公仔解锁
            if (this.resultMonsterLabel) {
                this.resultMonsterLabel.node.active = false;
            }
        }
        // A: 动态布局结算卡片（通过 monsterLabel.active 判断是否有公仔解锁）
        this.layoutResultPanel(isWin, this.resultMonsterLabel?.node.active ?? false);
        console.log(`[GameManager] 结算: ${isWin ? '过关' : '失败'} | 得分 ${this.currentScore}`);
    }

    /** X1/X2: 输出结构化难度诊断日志 + 持久化测试记录（防重复，同一局只输出一次） */
    private logDifficultyResult(isWin: boolean): void {
        if (this.difficultyResultLogged) return;
        this.difficultyResultLogged = true;

        const cfg = this.levelConfigs[this.currentLevel];
        const goal = this.getGoalProgressSnapshot(cfg);

        const assisted =
            this.hammerUsedThisRun ||
            this.shuffleUsedThisRun ||
            this.addStepsUsedThisRun ||
            this.continueAdUsed;

        const record: DifficultyRunRecord = {
            version: 1,
            timestamp: new Date().toISOString(),

            level: cfg.level,
            chapter: cfg.chapter,
            difficulty: cfg.difficulty,
            designIntent: cfg.designIntent,
            goalType: cfg.goalType,

            result: isWin ? 'win' : 'fail',
            attemptInSession: this.levelAttemptCounts[cfg.level] ?? 1,

            baseMoves: cfg.moves,
            validMovesUsed: this.validMovesUsedThisRun,
            stepsRemaining: this.currentSteps,
            score: this.currentScore,
            targetScore: this.safeNum(cfg.targetScore, 0),

            goalCurrent: goal.current,
            goalTarget: goal.target,
            goalProgress: goal.ratio,

            hammerUsed: this.hammerUsedThisRun,
            shuffleUsed: this.shuffleUsedThisRun,
            addStepsUsed: this.addStepsUsedThisRun,
            continueAdUsed: this.continueAdUsed,

            assisted,
        };

        // X3: collect 详情
        if (cfg.goalType === 'collect') {
            const colors = Array.isArray(cfg.goalColor) ? cfg.goalColor : [cfg.goalColor!];
            const counts = Array.isArray(cfg.goalCount) ? cfg.goalCount : [cfg.goalCount!];
            record.collectDetail = colors.map((color, i) => ({
                color,
                have: this.safeNum(this.collectedCount[color] ?? 0, 0),
                need: this.safeNum(counts[i], 0),
            }));
        }

        console.log('[DifficultyRun]', JSON.stringify(record));

        this.saveDifficultyRecord(record);

        // 输出当前关累计摘要
        const summaries = this.buildDifficultySummary(this.loadDifficultyRecords());
        const currentSummary = summaries.find(s => s.level === cfg.level);
        if (currentSummary) {
            console.log('[DifficultySummary]', JSON.stringify(currentSummary));
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  X2: 难度遥测 — 目标进度 / 存取 / 汇总 / 导出
    // ══════════════════════════════════════════════════════════════════════════

    /** X2: 计算当前目标进度快照 */
    private getGoalProgressSnapshot(cfg: LevelConfig): GoalProgressSnapshot {
        let current = 0;
        let target = 0;

        switch (cfg.goalType) {
            case 'score':
                current = this.safeNum(this.currentScore, 0);
                target = this.safeNum(cfg.targetScore, 0);
                break;
            case 'collect': {
                const colors = Array.isArray(cfg.goalColor) ? cfg.goalColor : [cfg.goalColor!];
                const counts = Array.isArray(cfg.goalCount) ? cfg.goalCount : [cfg.goalCount!];
                for (let i = 0; i < colors.length; i++) {
                    const need = this.safeNum(counts[i], 0);
                    const have = this.safeNum(this.collectedCount[colors[i]] ?? 0, 0);
                    current += Math.min(have, need);
                    target += need;
                }
                break;
            }
            case 'special':
                current = this.safeNum(this.detonatedSpecials, 0);
                target = this.safeNum(cfg.specialCount, 0);
                break;
            case 'ice':
                current = this.safeNum(this.clearedIceCells, 0);
                target = this.safeNum(cfg.iceTarget, 0);
                break;
            case 'crate':
                current = this.safeNum(this.clearedCrateCells, 0);
                target = this.safeNum(cfg.crateTarget, 0);
                break;
        }

        if (!isFinite(current) || current < 0) current = 0;
        if (!isFinite(target) || target < 0) target = 0;

        let ratio = target > 0 ? current / target : 0;
        if (!isFinite(ratio)) ratio = 0;
        ratio = Math.max(0, Math.min(1, ratio));

        return { current, target, ratio };
    }

    /** X2: 从 localStorage 加载测试记录 */
    private loadDifficultyRecords(): DifficultyRunRecord[] {
        try {
            const raw = sys.localStorage.getItem(GameManager.DIFFICULTY_TEST_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];

            const valid = parsed.filter((r: any) =>
                r && typeof r === 'object' &&
                r.version === 1 &&
                typeof r.level === 'number' && isFinite(r.level) &&
                r.level >= 1 && r.level <= 25 &&
                (r.result === 'win' || r.result === 'fail') &&
                typeof r.timestamp === 'string',
            );

            // 最多返回最近 500 条
            if (valid.length > GameManager.DIFFICULTY_TEST_MAX_RECORDS) {
                return valid.slice(valid.length - GameManager.DIFFICULTY_TEST_MAX_RECORDS);
            }
            return valid as DifficultyRunRecord[];
        } catch (e) {
            console.warn('[DifficultyTest] 加载测试记录失败:', e);
            return [];
        }
    }

    /** X2: 保存单局测试记录到 localStorage */
    private saveDifficultyRecord(record: DifficultyRunRecord): void {
        try {
            const records = this.loadDifficultyRecords();
            records.push(record);
            // 只保留最后 500 条
            const trimmed = records.length > GameManager.DIFFICULTY_TEST_MAX_RECORDS
                ? records.slice(records.length - GameManager.DIFFICULTY_TEST_MAX_RECORDS)
                : records;
            sys.localStorage.setItem(
                GameManager.DIFFICULTY_TEST_KEY,
                JSON.stringify(trimmed),
            );
        } catch (e) {
            console.warn('[DifficultyTest] 保存测试记录失败:', e);
        }
    }

    /** X2: 按关卡汇总统计 */
    private buildDifficultySummary(records: DifficultyRunRecord[]): DifficultyLevelSummary[] {
        const map = new Map<number, DifficultyRunRecord[]>();
        for (const r of records) {
            let arr = map.get(r.level);
            if (!arr) { arr = []; map.set(r.level, arr); }
            arr.push(r);
        }

        const summaries: DifficultyLevelSummary[] = [];

        for (const [level, recs] of map) {
            const attempts = recs.length;
            const wins = recs.filter(r => r.result === 'win').length;
            const fails = attempts - wins;

            const cleanRecs = recs.filter(r => !r.assisted);
            const cleanAttempts = cleanRecs.length;
            const cleanWins = cleanRecs.filter(r => r.result === 'win').length;

            const assistedRecs = recs.filter(r => r.assisted);
            const assistedAttempts = assistedRecs.length;
            const assistedWins = assistedRecs.filter(r => r.result === 'win').length;

            const winRecs = recs.filter(r => r.result === 'win');
            const failRecs = recs.filter(r => r.result === 'fail');

            const avgValidMoves = attempts > 0
                ? Math.round(recs.reduce((s, r) => s + this.safeNum(r.validMovesUsed, 0), 0) / attempts * 1000) / 1000
                : 0;
            const avgWinStepsRemaining = winRecs.length > 0
                ? Math.round(winRecs.reduce((s, r) => s + this.safeNum(r.stepsRemaining, 0), 0) / winRecs.length * 1000) / 1000
                : 0;
            const avgFailProgress = failRecs.length > 0
                ? Math.round(failRecs.reduce((s, r) => s + this.safeNum(r.goalProgress, 0), 0) / failRecs.length * 1000) / 1000
                : 0;

            const r3 = (n: number) => Math.round(n * 1000) / 1000;

            // X3: 高分关额外指标
            const scores = recs.map(r => this.safeNum(r.score, 0));
            const targetScore = this.safeNum(recs[0]?.targetScore, 0);
            const sortedScores = [...scores].sort((a, b) => a - b);
            const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0;
            const medianScore = sortedScores.length > 0
                ? sortedScores.length % 2 === 0
                    ? Math.round((sortedScores[sortedScores.length / 2 - 1] + sortedScores[sortedScores.length / 2]) / 2)
                    : sortedScores[Math.floor(sortedScores.length / 2)]
                : 0;
            const minScore = sortedScores.length > 0 ? sortedScores[0] : 0;
            const maxScore = sortedScores.length > 0 ? sortedScores[sortedScores.length - 1] : 0;
            const scoreReachedCount = targetScore > 0 ? scores.filter(s => s >= targetScore).length : 0;

            // X3: 收集关额外指标
            const collectDetail: { color: string; avgHave: number; need: number }[] = [];
            const firstCollect = recs.find(r => r.collectDetail && r.collectDetail.length > 0);
            if (firstCollect && firstCollect.collectDetail) {
                for (const cd of firstCollect.collectDetail) {
                    const allHaves = recs
                        .map(r => r.collectDetail?.find(d => d.color === cd.color)?.have ?? 0);
                    const avgHave = allHaves.length > 0
                        ? r3(allHaves.reduce((s, v) => s + v, 0) / allHaves.length)
                        : 0;
                    collectDetail.push({ color: cd.color, avgHave, need: cd.need });
                }
            }

            summaries.push({
                level,
                difficulty: recs[0]?.difficulty ?? 'normal',
                goalType: recs[0]?.goalType ?? 'score',

                attempts,
                wins,
                fails,
                winRate: r3(attempts > 0 ? wins / attempts : 0),

                cleanAttempts,
                cleanWins,
                cleanWinRate: r3(cleanAttempts > 0 ? cleanWins / cleanAttempts : 0),

                assistedAttempts,
                assistedWins,
                assistedWinRate: r3(assistedAttempts > 0 ? assistedWins / assistedAttempts : 0),

                avgValidMoves,
                avgWinStepsRemaining,
                avgFailProgress,

                hammerUseRate: r3(attempts > 0 ? recs.filter(r => r.hammerUsed).length / attempts : 0),
                shuffleUseRate: r3(attempts > 0 ? recs.filter(r => r.shuffleUsed).length / attempts : 0),
                addStepsUseRate: r3(attempts > 0 ? recs.filter(r => r.addStepsUsed).length / attempts : 0),
                continueAdUseRate: r3(attempts > 0 ? recs.filter(r => r.continueAdUsed).length / attempts : 0),

                // X3: 高分关额外指标
                targetScore,
                scores,
                avgScore,
                medianScore,
                minScore,
                maxScore,
                scoreReachedCount,

                // X3: 收集关额外指标
                collectDetail,
            });
        }

        summaries.sort((a, b) => a.level - b.level);
        return summaries;
    }

    /** X2: 导出完整测试报告 */
    private exportDifficultyTestReport(): string {
        const records = this.loadDifficultyRecords();
        const summaries = this.buildDifficultySummary(records);

        const report = {
            version: 2,
            exportedAt: new Date().toISOString(),
            totalRuns: records.length,
            summaries,
            records,
        };

        const text = JSON.stringify(report, null, 2);
        console.log('[DifficultyExport]\n' + text);
        return text;
    }

    /** X2: 打印所有关卡摘要 */
    private printDifficultySummary(): DifficultyLevelSummary[] {
        const records = this.loadDifficultyRecords();
        const summaries = this.buildDifficultySummary(records);
        if (typeof console.table === 'function') {
            console.table(summaries);
        }
        console.log('[DifficultySummaryAll]', JSON.stringify(summaries));
        return summaries;
    }

    /** X2: 清空难度测试数据 */
    private clearDifficultyTestData(): void {
        try {
            sys.localStorage.removeItem(GameManager.DIFFICULTY_TEST_KEY);
            console.log('[DifficultyTest] 测试数据已清空');
        } catch (e) {
            console.warn('[DifficultyTest] 清空测试数据失败:', e);
        }
    }

    /** X2: 安装控制台调试 API */
    private installDifficultyDebugApi(): void {
        try {
                (globalThis as any).__MXMH_DIFFICULTY__ = {
                export: () => this.exportDifficultyTestReport(),
                summary: () => this.printDifficultySummary(),
                clear: () => this.clearDifficultyTestData(),
                // X2: 自动测试机器人（全 25 关）
                autorun: () => this.startAutoTestRun(),
                // X2.2: 定点测试 — testrun([13,16,18,20,23], 3)
                testrun: (levels: number[], runs: number = 3) => this.startTargetedTestRun(levels, runs),
                // X3: 批量定点测试 — batchtest([{levels:[8,10,14,15,19,24],runs:5},{levels:[4,5,11],runs:3},{levels:[3,7,12,17,22],runs:3},{levels:[25],runs:5}])
                batchtest: (groups: { levels: number[]; runs: number }[]) => this.startBatchTestRun(groups),
                stop: () => this.stopAutoTest(),
            };
        } catch (e) {
            console.warn('[DifficultyTest] 安装调试 API 失败:', e);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  X2: 自动测试机器人 — 自动打完 25 关裸关
    // ══════════════════════════════════════════════════════════════════════════

    private _autoTestRunning = false;
    private _autoTestRetryCount = 0;
    private static readonly AUTO_TEST_MAX_RETRIES = 3;
    private static readonly AUTO_TEST_TICK_MS = 0.15;

    // X2.2: 定点测试支持
    private _autoTestTargetQueue: number[] = [];  // 待测关卡索引队列
    private _autoTestIsTargeted = false;           // 是否为定点测试模式

    /** X2: 启动自动测试，从 L1 开始打完 25 关 */
    private startAutoTestRun(): void {
        if (this._autoTestRunning) {
            console.log('[AutoTest] 已在运行中');
            return;
        }
        this._autoTestRunning = true;
        this._autoTestRetryCount = 0;
        this._autoTestIsTargeted = false;
        this._autoTestTargetQueue = [];
        console.log('[AutoTest] 开始自动测试 25 关裸关...');

        // 清空旧数据
        this.clearDifficultyTestData();

        // 从第一关开始
        this.startLevel(0);

        // 延迟启动机器人循环（等棋盘初始化完成）
        this.scheduleOnce(() => this.autoTestTick(), 0.5);
    }

    /** X2.2: 启动定点测试 — 指定关卡各打 N 局 */
    private startTargetedTestRun(levelNumbers: number[], runs: number): void {
        if (this._autoTestRunning) {
            console.log('[AutoTest] 已在运行中，请先 stop');
            return;
        }
        this._autoTestTargetQueue = [];
        for (const ln of levelNumbers) {
            const idx = ln - 1; // level number → array index
            if (idx >= 0 && idx < this.levelConfigs.length) {
                for (let i = 0; i < runs; i++) {
                    this._autoTestTargetQueue.push(idx);
                }
            } else {
                console.warn(`[AutoTest] L${ln} 不存在，跳过`);
            }
        }
        if (this._autoTestTargetQueue.length === 0) {
            console.log('[AutoTest] 队列为空，取消');
            return;
        }
        this._autoTestRunning = true;
        this._autoTestRetryCount = 0;
        this._autoTestIsTargeted = true;
        console.log(`[AutoTest] 定点测试开始：L${levelNumbers.join(',')} 各 ${runs} 局，共 ${this._autoTestTargetQueue.length} 局`);

        this.clearDifficultyTestData();

        const firstIdx = this._autoTestTargetQueue.shift()!;
        this.startLevel(firstIdx);
        this.scheduleOnce(() => this.autoTestTick(), 0.5);
    }

    /** X2.2: 定点测试 — 移到队列下一关，队列空则结束 */
    private advanceTargetedTest(): boolean {
        if (this._autoTestTargetQueue.length === 0) {
            this._autoTestRunning = false;
            this._autoTestIsTargeted = false;
            console.log('[AutoTest] ★ 定点测试全部完成！执行 export 导出数据');
            this.exportDifficultyTestReport();
            return false;
        }
        const nextIdx = this._autoTestTargetQueue.shift()!;
        console.log(`[AutoTest] → 下一关 L${this.levelConfigs[nextIdx].level}（队列剩余 ${this._autoTestTargetQueue.length}）`);
        this.startLevel(nextIdx);
        return true;
    }

    /** X3: 批量定点测试 — 多组关卡各打 N 局，一次调用完成全部 */
    private startBatchTestRun(groups: { levels: number[]; runs: number }[]): void {
        if (this._autoTestRunning) {
            console.log('[AutoTest] 已在运行中，请先 stop');
            return;
        }
        this._autoTestTargetQueue = [];
        let totalRuns = 0;
        const groupDesc: string[] = [];
        for (const g of groups) {
            groupDesc.push(`L${g.levels.join(',')}×${g.runs}`);
            for (const ln of g.levels) {
                const idx = ln - 1;
                if (idx >= 0 && idx < this.levelConfigs.length) {
                    for (let i = 0; i < g.runs; i++) {
                        this._autoTestTargetQueue.push(idx);
                        totalRuns++;
                    }
                } else {
                    console.warn(`[AutoTest] L${ln} 不存在，跳过`);
                }
            }
        }
        if (this._autoTestTargetQueue.length === 0) {
            console.log('[AutoTest] 队列为空，取消');
            return;
        }
        this._autoTestRunning = true;
        this._autoTestRetryCount = 0;
        this._autoTestIsTargeted = true;
        console.log(`[AutoTest] 批量测试开始：${groupDesc.join(' + ')}，共 ${totalRuns} 局`);

        this.clearDifficultyTestData();

        const firstIdx = this._autoTestTargetQueue.shift()!;
        this.startLevel(firstIdx);
        this.scheduleOnce(() => this.autoTestTick(), 0.5);
    }

    /** X2: 停止自动测试 */
    private stopAutoTest(): void {
        this._autoTestRunning = false;
        this._autoTestIsTargeted = false;
        this._autoTestTargetQueue = [];
        this._autoTestRetryCount = 0;
        console.log('[AutoTest] 已停止，状态已清理');
    }

    /** X2: 机器人主循环 — 每帧检查状态并行动 */
    private autoTestTick(): void {
        if (!this._autoTestRunning) return;

        // 1. 如果结算面板打开 → 处理下一局
        if (this.resultPanel?.active) {
            const config = this.levelConfigs[this.currentLevel];
            const isWin = this.isGoalReached(config);

            // X3.1: targeted / batch 模式 — 每项只跑一局，不重试
            if (this._autoTestIsTargeted) {
                console.log(`[AutoTest] L${config.level} ${isWin ? '过关' : '失败'}，进入下一个队列项`);
                this._autoTestRetryCount = 0;
                if (!this.advanceTargetedTest()) return;
                this.scheduleOnce(() => this.autoTestTick(), 0.5);
                return;
            }

            // X3.1: 非 targeted（autorun）模式 — 保留旧逻辑：失败最多重试 3 次
            if (isWin) {
                console.log(`[AutoTest] L${config.level} 过关`);
                this._autoTestRetryCount = 0;
                if (this.currentLevel >= this.levelConfigs.length - 1) {
                    this._autoTestRunning = false;
                    console.log('[AutoTest] ★ 25 关全部完成！执行 export 导出数据');
                    this.exportDifficultyTestReport();
                    return;
                }
                this.startLevel(this.currentLevel + 1);
            } else {
                this._autoTestRetryCount++;
                if (this._autoTestRetryCount >= GameManager.AUTO_TEST_MAX_RETRIES) {
                    console.log(`[AutoTest] L${config.level} 已失败 ${this._autoTestRetryCount} 次，跳过`);
                    this._autoTestRetryCount = 0;
                    if (this.currentLevel >= this.levelConfigs.length - 1) {
                        this._autoTestRunning = false;
                        console.log('[AutoTest] ★ 25 关全部完成！执行 export 导出数据');
                        this.exportDifficultyTestReport();
                        return;
                    }
                    this.startLevel(this.currentLevel + 1);
                } else {
                    console.log(`[AutoTest] L${config.level} 失败（第 ${this._autoTestRetryCount} 次），重玩本关`);
                    this.startLevel(this.currentLevel);
                }
            }
            this.scheduleOnce(() => this.autoTestTick(), 0.5);
            return;
        }

        // 2. 如果步数耗尽弹层打开 → 点放弃（记录失败）
        if (this.stepsPanel?.active) {
            console.log(`[AutoTest] L${this.levelConfigs[this.currentLevel].level} 步数耗尽，放弃`);
            this.onStepsGiveUpClick();
            this.scheduleOnce(() => this.autoTestTick(), 0.5);
            return;
        }

        // 3. 如果暂停面板打开 → 关闭
        if (this.pausePanel?.active) {
            this.hidePanel(this.pausePanel);
            this.scheduleOnce(() => this.autoTestTick(), 1.0);
            return;
        }

        // 4. 如果章节过场卡正在显示 → 跳过等待
        if (this.chapterCardShowing) {
            this.scheduleOnce(() => this.autoTestTick(), 0.3);
            return;
        }

        // 5. 棋盘忙碌 → 等待
        if (!this.board || this.board.state !== 0 /* BoardState.IDLE */) {
            this.scheduleOnce(() => this.autoTestTick(), 0.2);
            return;
        }

        // 6. 目标感知最优交换
        const config = this.levelConfigs[this.currentLevel];
        const params: { goalType: 'score' | 'collect' | 'special' | 'ice' | 'crate'; targetColors?: number[]; targetScore?: number; currentScore?: number } = {
            goalType: config.goalType,
            targetScore: config.targetScore,
            currentScore: this.currentScore,
        };

        // collect 类型：计算尚未达标的目标颜色 colorId 列表
        if (config.goalType === 'collect') {
            const colors = Array.isArray(config.goalColor) ? config.goalColor : [config.goalColor!];
            const counts = Array.isArray(config.goalCount) ? config.goalCount : [config.goalCount!];
            const remaining: number[] = [];
            for (let i = 0; i < colors.length; i++) {
                const need = this.safeNum(counts[i], 0);
                const have = this.safeNum(this.collectedCount[colors[i]] ?? 0, 0);
                if (have < need) {
                    const id = COLOR_KEY_MAP[colors[i]];
                    if (id !== undefined) remaining.push(id);
                }
            }
            params.targetColors = remaining;
        }

        const move = this.board.findBestTargetMove(params);
        if (move) {
            const dr = move.b.r - move.a.r;
            const dc = move.b.c - move.a.c;
            this.board.trySwapByDir(move.a.r, move.a.c, dr, dc);
        } else {
            console.log('[AutoTest] 无有效交换，等待自动洗牌');
        }

        // 循环
        this.scheduleOnce(() => this.autoTestTick(), GameManager.AUTO_TEST_TICK_MS);
    }

    /** 结算面板得分文本（按目标类型） */
    private getResultScoreText(cfg: LevelConfig): string {
        const score = this.currentScore;
        switch (cfg.goalType) {
            case 'score':
                return `本关得分: ${score} / ${this.safeNum(cfg.targetScore, 0)}`;
            case 'collect': {
                const colors = Array.isArray(cfg.goalColor) ? cfg.goalColor : [cfg.goalColor!];
                const counts = Array.isArray(cfg.goalCount) ? cfg.goalCount : [cfg.goalCount!];
                const parts = colors.map((key, i) => {
                    const id = COLOR_KEY_MAP[key] ?? 0;
                    const emoji = COLOR_EMOJI_MAP[id] ?? '?';
                    const have = this.collectedCount[key] ?? 0;
                    const need = this.safeNum(counts[i], 0);
                    return `${emoji}${have}/${need}`;
                });
                return `收集: ${parts.join(' ')}  |  得分 ${score}`;
            }
            case 'special':
                return `引爆: ${this.detonatedSpecials}/${this.safeNum(cfg.specialCount, 0)}  |  得分 ${score}`;
            case 'ice':
                return `🧊 碎冰: ${this.clearedIceCells}/${this.safeNum(cfg.iceTarget, 0)}  |  得分 ${score}`;
            case 'crate':
                return `📦 拆箱: ${this.clearedCrateCells}/${this.safeNum(cfg.crateTarget, 0)}  |  得分 ${score}`;
            default:
                return `本关得分: ${score}`;
        }
    }

    private onResultAdClick(): void {
        if (this.scoreDoubled) return;

        // 置灰按钮，防止广告展示期间重复点击
        this.resultAdBtn!.getComponent(Button)!.interactable = false;
        this.resultAdLabel!.string = '广告加载中...';

        AdManager.getInstance().showRewardedAd(
            () => {
                // ✓ 发奖：得分翻倍
                this.scoreDoubled = true;
                this.board?.multiplyScore(2);
                this.resultScore!.string = this.getResultScoreText(this.levelConfigs[this.currentLevel]);
                this.resultAdLabel!.string = '已翻倍';
                console.log(`[GameManager] 广告奖励 — 分数翻倍！当前得分: ${this.currentScore}`);
            },
            () => {
                // ✗ 未看完：恢复按钮可再次点击
                this.resultAdBtn!.getComponent(Button)!.interactable = true;
                this.resultAdLabel!.string = '▶  看广告·得分翻倍';
                console.log('[GameManager] 广告未看完，按钮恢复');
            },
        );
    }

    /** E5: 看广告·扭蛋币翻倍 — 成功则本关发放量 ×2 补发 */
    private onResultCoinAdClick(): void {
        if (this.coinDoubled) return;
        if (this.safeNum(this.lastCoinReward, 0) <= 0) return;

        // 置灰按钮
        this.resultCoinAdBtn!.getComponent(Button)!.interactable = false;
        this.resultCoinAdLabel!.string = '广告加载中...';

        AdManager.getInstance().showRewardedAd(
            () => {
                // ✓ 发奖：补发同等数量的扭蛋币
                this.coinDoubled = true;
                const bonus = this.safeNum(this.lastCoinReward, 0);
                SaveManager.inst.addCoins(bonus);
                this.resultCoinAdLabel!.string = `已翻倍 (+${bonus} 🎲)`;
                // 更新扭蛋币提示
                if (this.resultCoinLabel) {
                    const total = this.safeNum(this.lastCoinReward, 0) * 2;
                    this.resultCoinLabel.string = `+${total} 🎲 扭蛋币`;
                }
                console.log(`[GameManager] 广告奖励 — 扭蛋币翻倍！补发 +${bonus}`);
            },
            () => {
                // ✗ 未看完：恢复按钮
                this.resultCoinAdBtn!.getComponent(Button)!.interactable = true;
                this.resultCoinAdLabel!.string = '看广告·扭蛋币翻倍';
                console.log('[GameManager] 扭蛋币翻倍广告未看完，按钮恢复');
            },
        );
    }

    private onResultNextClick(): void {
        const config = this.levelConfigs[this.currentLevel];
        const isWin = this.isGoalReached(config);

        if (isWin) {
            if (this.currentLevel >= this.levelConfigs.length - 1) {
                console.log('[GameManager] 全部通关！回到第一关');
                this.startLevel(0);
            } else {
                this.startLevel(this.currentLevel + 1);
            }
        } else {
            this.startLevel(this.currentLevel);
        }
    }

    /** 结算页"关卡选择"按钮 → 返回选择页（刷新解锁状态） */
    private onResultLevelSelectClick(): void {
        this.hidePanel(this.resultPanel);
        this.showLevelSelectPanel();
        console.log('[GameManager] 返回关卡选择');
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  录屏 & 分享
    // ══════════════════════════════════════════════════════════════════════════

    /** 初始化录屏回调（onStop 拿到 videoPath 后启用分享按钮） */
    private setupRecorder(): void {
        RecorderManager.getInstance().on({
            onStop: (videoPath: string) => {
                if (videoPath) {
                    this.recordedVideoPath = videoPath;
                    // 启用分享按钮
                    if (this.resultShareBtn) {
                        this.resultShareBtn.getComponent(Button)!.interactable = true;
                        this.resultShareLabel!.string = '分享录屏';
                    }
                    console.log('[GameManager] 录屏完成，分享按钮已启用');
                } else {
                    this.recordedVideoPath = null;
                    if (this.resultShareBtn) {
                        this.resultShareBtn.getComponent(Button)!.interactable = false;
                        this.resultShareLabel!.string = '录屏不可用';
                    }
                    console.log('[GameManager] 录屏未获取 videoPath');
                }
            },
            onError: (err: any) => {
                console.error('[GameManager] 录屏错误:', err);
                this.recordedVideoPath = null;
                if (this.resultShareBtn) {
                    this.resultShareBtn.getComponent(Button)!.interactable = false;
                    this.resultShareLabel!.string = '录屏不可用';
                }
            },
        });
    }

    /** 分享录屏按钮点击 — 调 tt.shareAppMessage 带 videoPath（不强制分享） */
    private onShareRecordClick(): void {
        if (!this.recordedVideoPath) {
            console.warn('[GameManager] 无录屏视频可分享');
            return;
        }

        // 非抖音环境降级
        if (typeof tt === 'undefined' || typeof tt.shareAppMessage !== 'function') {
            console.log('[GameManager] 非抖音环境，分享录屏降级跳过');
            return;
        }

        try {
            tt.shareAppMessage({
                channel: 'video',
                title: `我在三消游戏里打了 ${this.currentScore} 分！`,
                desc: '快来挑战我吧！',
                videoPath: this.recordedVideoPath,
                extra: {
                    videoTopics: ['三消游戏', '休闲游戏'],
                },
            });
            console.log('[GameManager] 分享录屏已调起，videoPath:', this.recordedVideoPath);
        } catch (e) {
            console.error('[GameManager] 分享录屏异常:', e);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  弹层 — 步数耗尽
    // ══════════════════════════════════════════════════════════════════════════

    private showStepsPanel(): void {
        // 确保与暂停弹层互斥
        this.hidePanel(this.pausePanel);
        // X0: 刷新广告按钮状态（已用/加载中/可用）
        this.updateStepsAdState();
        this.showPanel(this.stepsPanel, true);
        // 步数耗尽弹层 → 显示游戏圈按钮（X3.1: 自动测试期间跳过）
        if (!this._autoTestRunning) {
            this.gameClubEntry?.show();
        }
        // 停止录屏（X3.1: 自动测试期间未启动录屏，也跳过停止）
        if (!this._autoTestRunning) {
            RecorderManager.getInstance().stop();
        }
        console.log('[GameManager] 步数耗尽弹层');
    }

    /** X0: 刷新步数耗尽弹层的广告按钮状态 */
    private updateStepsAdState(): void {
        if (!this.stepsAdBtn || !this.stepsAdBtn.isValid) return;
        const button = this.stepsAdBtn.getComponent(Button);
        if (!button) return;

        if (this.continueAdUsed) {
            button.interactable = false;
            if (this.stepsAdLabel && this.stepsAdLabel.isValid) {
                this.stepsAdLabel.string = '本局续步机会已使用';
            }
        } else if (this.continueAdPending) {
            button.interactable = false;
            if (this.stepsAdLabel && this.stepsAdLabel.isValid) {
                this.stepsAdLabel.string = '广告加载中…';
            }
        } else {
            button.interactable = true;
            if (this.stepsAdLabel && this.stepsAdLabel.isValid) {
                this.stepsAdLabel.string = '▶  看广告 +5 步';
            }
        }
    }

    private onStepsAdClick(): void {
        // X0: 入口保护 — 已用 / 进行中 / 弹层未开
        if (this.continueAdUsed) {
            console.log('[GameManager] 本局续步广告已使用，拒绝重复请求');
            this.updateStepsAdState();
            return;
        }
        if (this.continueAdPending) {
            console.log('[GameManager] 续步广告请求进行中，忽略重复点击');
            return;
        }
        if (!this.stepsPanel?.active) {
            console.log('[GameManager] 步数弹层未开启，拒绝续步广告');
            return;
        }

        this.continueAdPending = true;
        this.updateStepsAdState();

        const token = this.levelRunToken;

        AdManager.getInstance().showRewardedAd(
            () => {
                // X0: 旧关卡回调 → 丢弃
                if (token !== this.levelRunToken) {
                    console.log('[GameManager] 忽略旧关卡续步广告回调');
                    return;
                }
                // X0: 防重复发奖
                if (this.continueAdUsed) {
                    this.continueAdPending = false;
                    this.updateStepsAdState();
                    console.warn('[GameManager] 续步广告重复成功回调，已阻止重复发奖');
                    return;
                }
                this.continueAdUsed = true;
                this.continueAdPending = false;

                // ✓ 发奖：+5 步、关闭弹层、继续本关
                this.currentSteps += 5;
                this.updateHUD();
                this.updateStepsAdState();

                this.hidePanel(this.stepsPanel);
                this.board?.setBusy(false);
                // 回到游戏 → 隐藏游戏圈按钮
                this.gameClubEntry?.hide();

                console.log(
                    `[GameManager] 本局唯一续步广告发奖：+5 步，当前步数=${this.currentSteps}`,
                );
            },
            () => {
                // X0: 旧关卡回调 → 丢弃
                if (token !== this.levelRunToken) {
                    console.log('[GameManager] 忽略旧关卡续步广告失败回调');
                    return;
                }
                this.continueAdPending = false;
                this.updateStepsAdState();
                console.log('[GameManager] 广告未完成，本局续步机会未消耗');
            },
        );
    }

    private onStepsGiveUpClick(): void {
        this.hidePanel(this.stepsPanel);
        this.showResultPanel(false);
        console.log('[GameManager] 放弃，去结算');
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  UI 创建（程序化 — Widget 响应式布局）
    // ══════════════════════════════════════════════════════════════════════════

    private createAllUI(): void {
        const canvas = this.node.parent!;

        // ── 1. 背景：章节主题色竖向渐变 + 暗角 + 柔点装饰 ──
        const bgNode = new Node('Background');
        bgNode.parent = canvas;
        bgNode.setSiblingIndex(0); // 放最底
        const bgUT = bgNode.addComponent(UITransform);
        const bgW = this.safeNum(this.canvasW, 720);
        const bgH = this.safeNum(this.canvasH, 1280);
        bgUT.setContentSize(bgW, bgH);

        const bgG = bgNode.addComponent(Graphics);
        // 存储引用供章节切换时重绘
        this.gameBgNode = bgNode;
        this.gameBgG = bgG;
        this.gameBgOp = bgNode.addComponent(UIOpacity);

        // 初始绘制第1章主题色（后续 startLevel 会按 config.chapter 切换）
        const initTheme = GameManager.CHAPTER_BG_THEMES[0];
        const initTop = this.parseHexColor(initTheme.top, new Color(0xFD, 0xF2, 0xF8));
        const initBot = this.parseHexColor(initTheme.bottom, new Color(0xF5, 0xE8, 0xF0));
        const initMid = new Color(
            Math.round((initTop.r + initBot.r) / 2),
            Math.round((initTop.g + initBot.g) / 2),
            Math.round((initTop.b + initBot.b) / 2),
            255,
        );
        this.drawChapterBackground(initTop, initMid, initBot);

        this.addWidget(bgNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // ── 2. Board：仅水平居中，Y 在 start() 中手动设置 ──
        const boardNode = canvas.getChildByName('Board');
        if (boardNode) {
            boardNode.setPosition(0, 0, 0);
            const widget = boardNode.addComponent(Widget);
            widget.alignMode = Widget.AlignMode.ALWAYS;
            widget.isAlignHorizontalCenter = true;
            widget.horizontalCenter = 0;
            widget.updateAlignment();
        }

        // ── 3. HUD / 弹层 ──
        this.createHUD();
        this.createPauseButton();
        this.createBoosterBar();
        this.createResultPanel();
        this.createStepsPanel();
        this.createLevelSelectPanel();
        this.createGachaPanel();
        this.createCollectionPanel();
        this.createPausePanel();
        this.createHomePanel();
        this.createDressupPanel();
        this.createSettingsPanel();
        this.createDailySignPanel();
    }

    // ── HUD（细长药丸 + Layout 横排 + 三段单行 Label） ──────────

    private createHUD(): void {
        this.hudNode = new Node('HUD');
        this.hudNode.parent = this.node.parent!;

        const hudH = this.HUD_HEIGHT; // 68
        const canvasW = this.safeNum(this.canvasW, 750);

        // Fix 1.1: 固定宽度，不用 Layout.ResizeMode.CONTAINER（避免真机上 Layout 不跑/撑高/乱排）
        const pillW = Math.min(canvasW - 40, 560);

        const hudUT = this.hudNode.addComponent(UITransform);
        hudUT.setAnchorPoint(0.5, 0.5); // 中心锚点
        hudUT.setContentSize(pillW, hudH);

        // Widget：top + horizontalCenter（贴顶居中，不与右上角胶囊冲突）
        this.hudWidget = this.addWidget(this.hudNode, {
            top: this.safeNum(this.topInset + 12 + hudH, 112 + hudH),
            hCenter: 0,
        });

        // 药丸底条 Graphics
        const bar = this.hudNode.addComponent(Graphics);
        bar.fillColor = this.COLOR_HUD_BAR.clone();
        bar.strokeColor = this.COLOR_CARD_BORDER.clone();
        bar.lineWidth = 2;
        bar.roundRect(-pillW / 2, -hudH / 2, pillW, hudH, hudH / 2);
        bar.fill();
        bar.stroke();

        const fontSize = 30;
        const labelH = hudH;
        // 三段 Label 等距排列：左 1/4、中 1/2、右 3/4
        const slotW = (pillW - 48) / 3; // 内部三等分
        const xLeft = -(pillW / 2) + 24 + slotW / 2;
        const xMid = 0;
        const xRight = (pillW / 2) - 24 - slotW / 2;

        // LevelLabel（左）
        this.levelLabel = this.createLabel(this.hudNode, 'LevelLabel', `🏆 第1章 · 1/5`, fontSize, this.COLOR_HUD_TEXT);
        this.levelLabel.overflow = Label.Overflow.NONE;
        this.levelLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.levelLabel.verticalAlign = Label.VerticalAlign.CENTER;
        this.levelLabel.enableOutline = false;
        this.levelLabel.node.getComponent(UITransform)!.setContentSize(slotW, labelH);
        this.levelLabel.node.setPosition(xLeft, 0, 0);

        // ScoreLabel（中）
        this.scoreLabel = this.createLabel(this.hudNode, 'ScoreLabel', `🎯 0/600`, fontSize, this.COLOR_HUD_TEXT);
        this.scoreLabel.overflow = Label.Overflow.NONE;
        this.scoreLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.scoreLabel.verticalAlign = Label.VerticalAlign.CENTER;
        this.scoreLabel.enableOutline = false;
        this.scoreLabel.node.getComponent(UITransform)!.setContentSize(slotW, labelH);
        this.scoreLabel.node.setPosition(xMid, 0, 0);

        // StepsLabel（右）
        this.stepsLabel = this.createLabel(this.hudNode, 'StepsLabel', `👣 25`, fontSize, this.COLOR_HUD_TEXT);
        this.stepsLabel.overflow = Label.Overflow.NONE;
        this.stepsLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.stepsLabel.verticalAlign = Label.VerticalAlign.CENTER;
        this.stepsLabel.enableOutline = false;
        this.stepsLabel.node.getComponent(UITransform)!.setContentSize(slotW, labelH);
        this.stepsLabel.node.setPosition(xRight, 0, 0);

        // 延一帧重画 + 打诊断
        this.scheduleOnce(() => {
            this.redrawHudBar();
        }, 0);
    }

    /** 重画药丸底条 + 诊断 */
    private redrawHudBar(): void {
        if (!this.hudNode) return;
        const bar = this.hudNode.getComponent(Graphics);
        if (!bar) return;
        const ut = this.hudNode.getComponent(UITransform);
        if (!ut) return;
        const w = this.safeNum(ut.width, 560);
        const h = this.safeNum(this.HUD_HEIGHT, 68);
        // 强制 HUD 高度固定为 68
        ut.setContentSize(w, h);
        bar.clear();
        bar.fillColor = this.COLOR_HUD_BAR.clone();
        bar.strokeColor = this.COLOR_CARD_BORDER.clone();
        bar.lineWidth = 2;
        bar.roundRect(-w / 2, -h / 2, w, h, h / 2);
        bar.fill();
        bar.stroke();
    }

    // ── 暂停按钮（左上角圆形，游戏中常驻） ──────────────────

    private createPauseButton(): void {
        this.pauseBtn = new Node('PauseBtn');
        this.pauseBtn.parent = this.node.parent!;

        const size = 64;
        const ut = this.pauseBtn.addComponent(UITransform);
        ut.setContentSize(size, size);
        ut.setAnchorPoint(0.5, 0.5);

        // Widget：top-left，与 HUD 同高，避开右上角微信胶囊
        this.addWidget(this.pauseBtn, {
            top: this.safeNum(this.topInset + 12, 112),
            left: 16,
        });

        // 圆形底 + 描边
        const g = this.pauseBtn.addComponent(Graphics);
        g.fillColor = this.COLOR_HUD_BAR.clone();
        g.strokeColor = this.COLOR_CARD_BORDER.clone();
        g.lineWidth = 2;
        g.circle(0, 0, size / 2);
        g.fill();
        g.stroke();

        // 两竖条 ⏸ 图标
        const barW = 6;
        const barH = 24;
        const barGap = 8;
        g.fillColor = this.COLOR_HUD_TEXT.clone();
        g.roundRect(-barGap / 2 - barW, -barH / 2, barW, barH, 3);
        g.fill();
        g.roundRect(barGap / 2, -barH / 2, barW, barH, 3);
        g.fill();

        // ★ P1: Button.Transition.NONE（手动 tween 统一控制缩放）
        const button = this.pauseBtn.addComponent(Button);
        button.transition = Button.Transition.NONE;

        button.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(this.pauseBtn!);
            this.pauseBtn!.setScale(0.95, 0.95, 1);
            tween(this.pauseBtn!)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        button.node.on(Button.EventType.CLICK, () => this.onPauseClick(), this);

        // 初始隐藏（未进关卡）
        this.pauseBtn.active = false;
    }

    // ── 结算弹层（遮罩 + 奶白圆角卡片 + Layout 竖排） ──

    private createResultPanel(): void {
        // ResultPanel 全屏容器
        this.resultPanel = new Node('ResultPanel');
        this.resultPanel.parent = this.node.parent!;
        const panelUT = this.resultPanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.resultPanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask：半透明黑遮罩 + BlockInputEvents 拦点击
        const maskNode = new Node('Mask');
        maskNode.parent = this.resultPanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 150);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity); // 用于淡入淡出
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card 尺寸（NaN 兜底）— 高度由 layoutResultPanel 动态计算
        const cardW = this.resultCardW, cardH = 780;

        // Shadow：向下投影（偏移 -6px、半透明黑、略大于卡片）
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.resultPanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(
            -(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2,
            cardW + sPad * 2, cardH + sPad * 2, 28 + sPad,
        );
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: 34 }); // 40 - 6 = 34，向下偏移
        this.resultShadowG = shadowG;
        this.resultShadowUT = shadowUT;

        // Card：奶白圆角卡片 + 淡紫描边
        const card = new Node('Card');
        card.parent = this.resultPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 40 });
        this.resultCardNode = card;
        this.resultCardUT = cardUT;

        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();
        this.resultCardG = cardG;

        // A: 去掉 Layout(VERTICAL)，改由 layoutResultPanel 手动 setPosition 排列

        // Title（深紫高对比、加粗、SHRINK 防裁切）
        this.resultTitle = this.createLabel(card, 'Title', '', 52, this.COLOR_TITLE_WIN);
        this.resultTitle.isBold = true;
        const titleW = this.safeNum(cardW - 80, 440);
        this.resultTitle.node.getComponent(UITransform)!.setContentSize(titleW, 76);
        this.resultTitle.overflow = Label.Overflow.SHRINK;
        this.resultTitle.enableWrapText = false;

        // Score（加粗、SHRINK 防溢出）
        this.resultScore = this.createLabel(card, 'Score', '', 38, this.COLOR_TEXT_MAIN);
        this.resultScore.isBold = true;
        const scoreW = this.safeNum(cardW - 80, 440);
        this.resultScore.node.getComponent(UITransform)!.setContentSize(scoreW, 56);
        this.resultScore.overflow = Label.Overflow.SHRINK;
        this.resultScore.enableWrapText = false;

        // 扭蛋币提示（E1：过关显示 +N 🎲 扭蛋币）
        this.resultCoinLabel = this.createLabel(card, 'CoinReward', '', 28, this.COLOR_CHAPTER_GOLD);
        this.resultCoinLabel.isBold = true;
        const coinW = this.safeNum(cardW - 80, 440);
        this.resultCoinLabel.node.getComponent(UITransform)!.setContentSize(coinW, 40);
        this.resultCoinLabel.overflow = Label.Overflow.SHRINK;
        this.resultCoinLabel.enableWrapText = false;
        this.resultCoinLabel.node.active = false;

        // 章末公仔解锁提示（仅 Boss 首次通关时显示）
        this.resultMonsterLabel = this.createLabel(card, 'MonsterUnlock', '', 32, this.COLOR_CHAPTER_GOLD);
        this.resultMonsterLabel.isBold = true;
        const monW = this.safeNum(cardW - 80, 440);
        this.resultMonsterLabel.node.getComponent(UITransform)!.setContentSize(monW, 48);
        this.resultMonsterLabel.overflow = Label.Overflow.SHRINK;
        this.resultMonsterLabel.enableWrapText = false;
        this.resultMonsterLabel.node.active = false;

        // 广告按钮（暖金高亮实心）— A: 高度 94→82
        this.resultAdBtn = this.createRoundButton(card, 'AdBtn', '▶  看广告·得分翻倍',
            this.COLOR_BTN_AD, 440, 82, () => this.onResultAdClick());
        this.resultAdLabel = this.resultAdBtn.getChildByName('Label')!.getComponent(Label)!;

        // 分享按钮 — A: 高度 94→82
        this.resultShareBtn = this.createRoundButton(card, 'ShareBtn', '录屏不可用',
            this.COLOR_BTN_GIVEUP, 440, 82, () => this.onShareRecordClick());
        this.resultShareLabel = this.resultShareBtn.getChildByName('Label')!.getComponent(Label)!;
        this.resultShareBtn.getComponent(Button)!.interactable = false;

        // 主按钮（下一关/重玩 = 主色实心）— A: 高度 94→82
        this.resultNextBtn = this.createRoundButton(card, 'NextBtn', '下一关',
            this.COLOR_BTN_PRIMARY, 440, 82, () => this.onResultNextClick());
        this.resultNextLabel = this.resultNextBtn.getChildByName('Label')!.getComponent(Label)!;

        // 关卡选择按钮（幽灵按钮：透明底 + 描边）
        this.resultSelectBtn = this.createRoundButton(card, 'SelectBtn', '关卡选择',
            this.COLOR_BTN_GIVEUP, 440, 80, () => this.onResultLevelSelectClick(),
            { ghost: true });
        this.resultSelectLabel = this.resultSelectBtn.getChildByName('Label')!.getComponent(Label)!;

        // E5: 扭蛋币翻倍广告按钮（仅过关显示）
        this.resultCoinAdBtn = this.createRoundButton(card, 'CoinAdBtn', '看广告·扭蛋币翻倍',
            this.COLOR_CHAPTER_GOLD, 440, 80, () => this.onResultCoinAdClick());
        this.resultCoinAdLabel = this.resultCoinAdBtn.getChildByName('Label')!.getComponent(Label)!;
        this.resultCoinAdBtn.active = false;

        this.resultPanel.active = false;
    }

    /** A: 结算弹层动态布局 — 根据显示项计算卡片高度并手动排列 */
    private layoutResultPanel(isWin: boolean, hasMonsterUnlock: boolean): void {
        if (!this.resultCardG || !this.resultCardUT || !this.resultCardNode) return;

        const cardW = this.safeNum(this.resultCardW, 560);

        // 确定本次显示哪些元素
        const showCoinLabel = isWin;
        const showMonsterLabel = hasMonsterUnlock;
        const showCoinAdBtn = isWin && this.safeNum(this.lastCoinReward, 0) > 0;

        // 元素高度
        const titleH = 76, scoreH = 56, coinLabelH = 40, monsterLabelH = 48;
        const adBtnH = 82, shareBtnH = 82, nextBtnH = 82, selectBtnH = 80, coinAdBtnH = 80;
        const gapLabel = 12, gapBtn = 18, paddingTop = 40, paddingBottom = 40;

        // 计算所需高度
        let needH = paddingTop + titleH + gapLabel + scoreH;
        if (showCoinLabel) needH += gapLabel + coinLabelH;
        if (showMonsterLabel) needH += gapLabel + monsterLabelH;
        needH += gapBtn + adBtnH + gapBtn + shareBtnH + gapBtn + nextBtnH + gapBtn + selectBtnH;
        if (showCoinAdBtn) needH += gapBtn + coinAdBtnH;
        needH += paddingBottom;

        const cardH = Math.max(720, Math.min(1060, needH));

        // 重绘卡片背景
        this.resultCardG.clear();
        this.resultCardG.fillColor = this.COLOR_CARD.clone();
        this.resultCardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        this.resultCardG.lineWidth = 2;
        this.resultCardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        this.resultCardG.fill();
        this.resultCardG.stroke();
        this.resultCardUT.setContentSize(cardW, cardH);

        // 重绘投影
        if (this.resultShadowG && this.resultShadowUT) {
            const sPad = 14;
            this.resultShadowG.clear();
            this.resultShadowG.fillColor = new Color(0, 0, 0, 50);
            this.resultShadowG.roundRect(
                -(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2,
                cardW + sPad * 2, cardH + sPad * 2, 28 + sPad,
            );
            this.resultShadowG.fill();
            this.resultShadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        }

        // 从卡片顶部往下手动排列
        let y = this.safeNum(cardH / 2 - paddingTop, 0);

        const place = (node: Node | null, h: number, gap: number) => {
            if (!node) return;
            y -= gap + h / 2;
            node.setPosition(0, this.safeNum(y, 0), 0);
            y -= h / 2;
        };

        // Title
        if (this.resultTitle) { y -= titleH / 2; this.resultTitle.node.setPosition(0, this.safeNum(y, 0), 0); y -= titleH / 2; }
        // Score
        if (this.resultScore) { y -= scoreH / 2; this.resultScore.node.setPosition(0, this.safeNum(y, 0), 0); y -= scoreH / 2; }
        // CoinLabel (only win)
        if (showCoinLabel) place(this.resultCoinLabel?.node ?? null, coinLabelH, gapLabel);
        // MonsterLabel (only boss first clear)
        if (showMonsterLabel) place(this.resultMonsterLabel?.node ?? null, monsterLabelH, gapLabel);
        // AdBtn
        place(this.resultAdBtn, adBtnH, gapBtn);
        // ShareBtn
        place(this.resultShareBtn, shareBtnH, gapBtn);
        // NextBtn
        place(this.resultNextBtn, nextBtnH, gapBtn);
        // SelectBtn
        place(this.resultSelectBtn, selectBtnH, gapBtn);
        // CoinAdBtn (only win with coins)
        if (showCoinAdBtn) place(this.resultCoinAdBtn, coinAdBtnH, gapBtn);
    }

    // ── 步数耗尽弹层（同款遮罩 + 奶白卡片） ──

    private createStepsPanel(): void {
        this.stepsPanel = new Node('StepsPanel');
        this.stepsPanel.parent = this.node.parent!;
        const panelUT = this.stepsPanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.stepsPanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask
        const maskNode = new Node('Mask');
        maskNode.parent = this.stepsPanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 150);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity);
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card 尺寸
        const cardW = 520, cardH = 480;

        // Shadow
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.stepsPanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(
            -(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2,
            cardW + sPad * 2, cardH + sPad * 2, 28 + sPad,
        );
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: -6 }); // 向下偏移 6px

        // Card
        const card = new Node('Card');
        card.parent = this.stepsPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 0 });

        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        // Layout
        const cardLayout = card.addComponent(Layout);
        cardLayout.type = Layout.Type.VERTICAL;
        cardLayout.spacingY = 28;
        cardLayout.paddingTop = 44;
        cardLayout.paddingBottom = 44;
        cardLayout.horizontalDirection = Layout.HorizontalDirection.CENTER;
        cardLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
        cardLayout.resizeMode = Layout.ResizeMode.NONE;

        // Title（深紫高对比、加粗、SHRINK 防裁切）
        const msgLabel = this.createLabel(card, 'Message', '步数用完啦 👣', 48, this.COLOR_TITLE_LOSE);
        msgLabel.isBold = true;
        const stepsTitleW = this.safeNum(cardW - 80, 440);
        msgLabel.node.getComponent(UITransform)!.setContentSize(stepsTitleW, 76);
        msgLabel.overflow = Label.Overflow.SHRINK;
        msgLabel.enableWrapText = false;

        // 广告按钮（暖金高亮实心）
        this.stepsAdBtn = this.createRoundButton(card, 'AdBtn', '▶  看广告 +5 步',
            this.COLOR_BTN_AD, 440, 94, () => this.onStepsAdClick());
        this.stepsAdLabel =
            this.stepsAdBtn.getChildByName('Label')?.getComponent(Label) ?? null;

        // 放弃按钮（幽灵按钮：透明底 + 描边）
        this.createRoundButton(card, 'GiveUpBtn', '放弃·去结算',
            this.COLOR_BTN_GIVEUP, 440, 94, () => this.onStepsGiveUpClick(),
            { ghost: true });

        this.stepsPanel.active = false;
    }

    // ── 暂停弹层（遮罩 + 奶白卡片 + 三按钮竖排 + 重玩二次确认） ──────────

    private createPausePanel(): void {
        this.pausePanel = new Node('PausePanel');
        this.pausePanel.parent = this.node.parent!;
        const panelUT = this.pausePanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.pausePanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask
        const maskNode = new Node('Mask');
        maskNode.parent = this.pausePanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 150);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity);
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card 尺寸（动态求和：paddingTop44 + 标题76 + 3按钮×88 + 3间距×28 + paddingBottom44 = 512）
        const cardW = 480;
        const cardH = this.safeNum(44 + 76 + 3 * 88 + 3 * 28 + 44, 512);

        // Shadow
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.pausePanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(
            -(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2,
            cardW + sPad * 2, cardH + sPad * 2, 28 + sPad,
        );
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: -6 });

        // ── 主卡片 ──
        const card = new Node('Card');
        card.parent = this.pausePanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 0 });
        this.pauseCard = card;

        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        const cardLayout = card.addComponent(Layout);
        cardLayout.type = Layout.Type.VERTICAL;
        cardLayout.spacingY = 28;
        cardLayout.paddingTop = 44;
        cardLayout.paddingBottom = 44;
        cardLayout.horizontalDirection = Layout.HorizontalDirection.CENTER;
        cardLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
        cardLayout.resizeMode = Layout.ResizeMode.NONE;

        // Title
        const titleLabel = this.createLabel(card, 'Title', '暂停', 48, this.COLOR_TITLE_WIN);
        titleLabel.isBold = true;
        const titleW = this.safeNum(cardW - 80, 400);
        titleLabel.node.getComponent(UITransform)!.setContentSize(titleW, 76);
        titleLabel.overflow = Label.Overflow.SHRINK;
        titleLabel.enableWrapText = false;

        // ① 继续（主色实心）
        this.createRoundButton(card, 'ContinueBtn', '继续',
            this.COLOR_BTN_PRIMARY, 440, 88, () => this.onPauseContinue());

        // ② 重玩本关（幽灵按钮）
        this.createRoundButton(card, 'RestartBtn', '重玩本关',
            this.COLOR_BTN_GIVEUP, 440, 88, () => this.onPauseRestartClick(),
            { ghost: true });

        // ③ 返回关卡选择（幽灵按钮）
        this.createRoundButton(card, 'LevelSelectBtn', '返回关卡选择',
            this.COLOR_BTN_GIVEUP, 440, 88, () => this.onPauseLevelSelect(),
            { ghost: true });

        // ── 确认卡片（重玩二次确认，初始隐藏） ──
        const confirmCard = new Node('ConfirmCard');
        confirmCard.parent = this.pausePanel;
        const confirmUT = confirmCard.addComponent(UITransform);
        // 确认卡尺寸（动态求和：paddingTop44 + 标题66 + 提示44 + 2按钮×88 + 3间距×24 + paddingBottom44 = 446）
        const confirmW = 480;
        const confirmH = this.safeNum(44 + 66 + 44 + 2 * 88 + 3 * 24 + 44, 446);
        confirmUT.setContentSize(confirmW, confirmH);
        this.addWidget(confirmCard, { hCenter: 0, vCenter: 0 });
        this.pauseConfirmCard = confirmCard;

        const confirmG = confirmCard.addComponent(Graphics);
        confirmG.fillColor = this.COLOR_CARD.clone();
        confirmG.strokeColor = this.COLOR_CARD_BORDER.clone();
        confirmG.lineWidth = 2;
        confirmG.roundRect(-confirmW / 2, -confirmH / 2, confirmW, confirmH, 28);
        confirmG.fill();
        confirmG.stroke();

        const confirmLayout = confirmCard.addComponent(Layout);
        confirmLayout.type = Layout.Type.VERTICAL;
        confirmLayout.spacingY = 24;
        confirmLayout.paddingTop = 44;
        confirmLayout.paddingBottom = 44;
        confirmLayout.horizontalDirection = Layout.HorizontalDirection.CENTER;
        confirmLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
        confirmLayout.resizeMode = Layout.ResizeMode.NONE;

        // 确认标题
        const confirmTitle = this.createLabel(confirmCard, 'ConfirmTitle', '确认重玩？', 42, this.COLOR_TITLE_WIN);
        confirmTitle.isBold = true;
        const cTitleW = this.safeNum(confirmW - 80, 400);
        confirmTitle.node.getComponent(UITransform)!.setContentSize(cTitleW, 66);
        confirmTitle.overflow = Label.Overflow.SHRINK;
        confirmTitle.enableWrapText = false;

        // 确认提示
        const confirmDesc = this.createLabel(confirmCard, 'ConfirmDesc', '本关进度将清零', 28, this.COLOR_TEXT_MAIN);
        const cDescW = this.safeNum(confirmW - 80, 400);
        confirmDesc.node.getComponent(UITransform)!.setContentSize(cDescW, 44);
        confirmDesc.overflow = Label.Overflow.SHRINK;
        confirmDesc.enableWrapText = false;

        // 确认按钮（主色实心）
        this.createRoundButton(confirmCard, 'ConfirmBtn', '确认重玩',
            this.COLOR_BTN_PRIMARY, 440, 88, () => this.onPauseRestartConfirm());

        // 取消按钮（幽灵按钮）
        this.createRoundButton(confirmCard, 'CancelBtn', '取消',
            this.COLOR_BTN_GIVEUP, 440, 88, () => this.onPauseRestartCancel(),
            { ghost: true });

        // 确认卡片初始隐藏
        confirmCard.active = false;

        this.pausePanel.active = false;
    }

    // ── 关卡选择页（全屏层 · 遮罩 + 奶白卡片 · 3 章分组） ──────────────────

    private createLevelSelectPanel(): void {
        this.levelSelectPanel = new Node('LevelSelectPanel');
        this.levelSelectPanel.parent = this.node.parent!;
        const panelUT = this.levelSelectPanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.levelSelectPanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask：半透明黑遮罩 + BlockInputEvents
        const maskNode = new Node('Mask');
        maskNode.parent = this.levelSelectPanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 160);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity);
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card 尺寸（V: 加高 1080→1280 以容纳第5章 5 组关卡按钮）
        const cardW = this.safeNum(640, 640);
        const cardH = this.safeNum(1280, 1280);

        // Shadow
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.levelSelectPanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(
            -(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2,
            cardW + sPad * 2, cardH + sPad * 2, 28 + sPad,
        );
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: 0 });

        // Card：奶白圆角卡片
        const card = new Node('Card');
        card.parent = this.levelSelectPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 0 });

        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        // Layout 竖排
        const cardLayout = card.addComponent(Layout);
        cardLayout.type = Layout.Type.VERTICAL;
        cardLayout.spacingY = this.safeNum(10, 10);
        cardLayout.paddingTop = this.safeNum(28, 28);
        cardLayout.paddingBottom = this.safeNum(28, 28);
        cardLayout.horizontalDirection = Layout.HorizontalDirection.CENTER;
        cardLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
        cardLayout.resizeMode = Layout.ResizeMode.NONE;

        // Header
        const headerLabel = this.createLabel(card, 'Header', '选择关卡', 44, this.COLOR_TITLE_WIN);
        headerLabel.isBold = true;
        const headerW = this.safeNum(cardW - 80, 560);
        headerLabel.node.getComponent(UITransform)!.setContentSize(headerW, 56);
        headerLabel.overflow = Label.Overflow.SHRINK;
        headerLabel.enableWrapText = false;

        // B: 资源徽章条（只读）— 左扭蛋币 / 右图鉴进度
        const badgeBar = new Node('BadgeBar');
        badgeBar.parent = card;
        const badgeW = this.safeNum(cardW - 60, 580);
        const badgeH = 36;
        badgeBar.addComponent(UITransform).setContentSize(badgeW, badgeH);

        this.levelSelectCoinBadge = this.createLabel(badgeBar, 'CoinBadge', '', 24, this.COLOR_CHAPTER_GOLD);
        this.levelSelectCoinBadge.isBold = true;
        this.levelSelectCoinBadge.node.getComponent(UITransform)!.setContentSize(this.safeNum(badgeW / 2 - 10, 280), badgeH);
        this.levelSelectCoinBadge.overflow = Label.Overflow.SHRINK;
        this.levelSelectCoinBadge.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.levelSelectCoinBadge.node.setPosition(this.safeNum(-badgeW / 4, -145), 0, 0);

        this.levelSelectCollectionBadge = this.createLabel(badgeBar, 'CollectionBadge', '', 24, this.COLOR_HUD_TEXT);
        this.levelSelectCollectionBadge.isBold = true;
        this.levelSelectCollectionBadge.node.getComponent(UITransform)!.setContentSize(this.safeNum(badgeW / 2 - 10, 280), badgeH);
        this.levelSelectCollectionBadge.overflow = Label.Overflow.SHRINK;
        this.levelSelectCollectionBadge.horizontalAlign = Label.HorizontalAlign.RIGHT;
        this.levelSelectCollectionBadge.node.setPosition(this.safeNum(badgeW / 4, 145), 0, 0);

        // 4 章分组
        const chapterNames = ['', '第 1 章 · 入门', '第 2 章 · 进阶', '第 3 章 · 挑战', '第 4 章 · 新篇', '第 5 章 · 拆箱'];
        // ★ I1: 复用 G1 章节主题色常量，每章分组标题条用该章色调底衬
        const chapterAccentColors = [
            this.parseHexColor(GameManager.CHAPTER_BG_THEMES[0].bottom, new Color(0xF5, 0xE8, 0xF0)), // 暖粉
            this.parseHexColor(GameManager.CHAPTER_BG_THEMES[1].bottom, new Color(0xDC, 0xED, 0xE4)), // 薄荷
            this.parseHexColor(GameManager.CHAPTER_BG_THEMES[2].bottom, new Color(0xE2, 0xD8, 0xEE)), // 薰衣草
            this.parseHexColor(GameManager.CHAPTER_BG_THEMES[3].bottom, new Color(0xF5, 0xE6, 0xD3)), // 暖橘
            this.parseHexColor(GameManager.CHAPTER_BG_THEMES[4].bottom, new Color(0xEB, 0xD9, 0xC8)), // 温暖木色
        ];
        const btnSize = 100;
        const gap = 15;

        for (let ch = 1; ch <= 5; ch++) {
            // ★ I1: 章节标题条底衬（该章主题色）
            const chTitleBar = new Node(`Ch${ch}TitleBar`);
            chTitleBar.parent = card;
            const barW = this.safeNum(cardW - 60, 580);
            const barH = 40;
            chTitleBar.addComponent(UITransform).setContentSize(barW, barH);
            const barG = chTitleBar.addComponent(Graphics);
            const accentColor = chapterAccentColors[ch - 1];
            barG.fillColor = new Color(accentColor.r, accentColor.g, accentColor.b, 200);
            barG.roundRect(-barW / 2, -barH / 2, barW, barH, 12);
            barG.fill();

            // 章节标题
            const chTitle = this.createLabel(chTitleBar, `Ch${ch}Title`, chapterNames[ch], 28, this.COLOR_HUD_TEXT);
            chTitle.isBold = true;
            const chTitleW = this.safeNum(barW - 20, 540);
            chTitle.node.getComponent(UITransform)!.setContentSize(chTitleW, barH);
            chTitle.overflow = Label.Overflow.SHRINK;
            chTitle.enableWrapText = false;
            chTitle.node.setPosition(0, 0, 0);

            // 按钮排容器
            const rowNode = new Node(`Ch${ch}Row`);
            rowNode.parent = card;
            const rowW = this.safeNum(5 * btnSize + 4 * gap, 560);
            const rowH = this.safeNum(btnSize + 18, 118); // 加高行容器以容纳 Boss 标识在格子上方
            rowNode.addComponent(UITransform).setContentSize(rowW, rowH);

            const rowLayout = rowNode.addComponent(Layout);
            rowLayout.type = Layout.Type.HORIZONTAL;
            rowLayout.spacingX = gap;
            rowLayout.horizontalDirection = Layout.HorizontalDirection.LEFT_TO_RIGHT;
            rowLayout.verticalDirection = Layout.VerticalDirection.CENTER;
            rowLayout.resizeMode = Layout.ResizeMode.NONE;

            // 创建 5 个关卡按钮
            const startIdx = (ch - 1) * 5;
            for (let i = 0; i < 5; i++) {
                const levelIdx = startIdx + i;
                const config = this.levelConfigs[levelIdx];
                this.createLevelButton(rowNode, levelIdx, config, btnSize);
            }
        }

        // 抽卡 + 图鉴入口按钮
        this.createRoundButton(card, 'GachaEntryBtn', '🎲  抽卡',
            this.COLOR_BTN_AD, 280, 70, () => this.showGachaPanel());
        this.createRoundButton(card, 'CollectionEntryBtn', '📖  图鉴',
            this.COLOR_BTN_PRIMARY, 280, 70, () => this.showCollectionPanel(),
            { ghost: true });

        // Q2: 装扮入口按钮
        this.createRoundButton(card, 'DressupEntryBtn', '👗  装扮',
            this.COLOR_BTN_AD, 280, 60, () => this.showDressupPanel());

        // ★ M-A: 左上角「🏠 返回首页」浮层按钮（挂 panel 根节点，不挂 card）
        const homeBtn = new Node('HomeBtn');
        homeBtn.parent = this.levelSelectPanel;
        const homeSize = 64;
        const homeUT = homeBtn.addComponent(UITransform);
        homeUT.setContentSize(homeSize, homeSize);
        homeUT.setAnchorPoint(0.5, 0.5);
        this.addWidget(homeBtn, {
            top: this.safeNum(this.topInset + 12, 112),
            left: 16,
        });

        const homeG = homeBtn.addComponent(Graphics);
        homeG.fillColor = this.COLOR_HUD_BAR.clone();
        homeG.strokeColor = this.COLOR_CARD_BORDER.clone();
        homeG.lineWidth = 2;
        homeG.circle(0, 0, homeSize / 2);
        homeG.fill();
        homeG.stroke();

        // 🏠 图标
        const homeLabelNode = new Node('Label');
        homeLabelNode.parent = homeBtn;
        const homeLabelUT = homeLabelNode.addComponent(UITransform);
        homeLabelUT.setContentSize(homeSize, homeSize);
        const homeLabel = homeLabelNode.addComponent(Label);
        homeLabel.string = '🏠';
        homeLabel.fontSize = 32;
        homeLabel.lineHeight = 36;
        homeLabel.color = this.COLOR_HUD_TEXT.clone();
        homeLabel.useSystemFont = true;
        homeLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        homeLabel.verticalAlign = Label.VerticalAlign.CENTER;

        // ★ P1: Button.Transition.NONE（手动 tween 统一控制缩放）
        const homeButton = homeBtn.addComponent(Button);
        homeButton.transition = Button.Transition.NONE;
        homeButton.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(homeBtn);
            homeBtn.setScale(0.95, 0.95, 1);
            tween(homeBtn)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        homeButton.node.on(Button.EventType.CLICK, () => this.onLevelSelectHome(), this);

        // R2: 右上角「⚙️」设置按钮（挂 panel 根节点，与 HomeBtn 对称）
        const settingsBtn = new Node('SettingsBtn');
        settingsBtn.parent = this.levelSelectPanel;
        const settingsBtnSize = 64;
        const settingsBtnUT = settingsBtn.addComponent(UITransform);
        settingsBtnUT.setContentSize(settingsBtnSize, settingsBtnSize);
        settingsBtnUT.setAnchorPoint(0.5, 0.5);
        this.addWidget(settingsBtn, {
            top: this.safeNum(this.topInset + 12, 112),
            right: 16,
        });

        const settingsBtnG = settingsBtn.addComponent(Graphics);
        settingsBtnG.fillColor = this.COLOR_HUD_BAR.clone();
        settingsBtnG.strokeColor = this.COLOR_CARD_BORDER.clone();
        settingsBtnG.lineWidth = 2;
        settingsBtnG.circle(0, 0, settingsBtnSize / 2);
        settingsBtnG.fill();
        settingsBtnG.stroke();

        const settingsBtnLabelNode = new Node('Label');
        settingsBtnLabelNode.parent = settingsBtn;
        const settingsBtnLabelUT = settingsBtnLabelNode.addComponent(UITransform);
        settingsBtnLabelUT.setContentSize(settingsBtnSize, settingsBtnSize);
        const settingsBtnLabel = settingsBtnLabelNode.addComponent(Label);
        settingsBtnLabel.string = '⚙️';
        settingsBtnLabel.fontSize = 30;
        settingsBtnLabel.lineHeight = 34;
        settingsBtnLabel.color = this.COLOR_HUD_TEXT.clone();
        settingsBtnLabel.useSystemFont = true;
        settingsBtnLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        settingsBtnLabel.verticalAlign = Label.VerticalAlign.CENTER;

        const settingsButton = settingsBtn.addComponent(Button);
        settingsButton.transition = Button.Transition.NONE;
        settingsButton.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(settingsBtn);
            settingsBtn.setScale(0.95, 0.95, 1);
            tween(settingsBtn)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        settingsButton.node.on(Button.EventType.CLICK, () => this.showSettingsPanel(), this);

        // R3: 右上角「📅」签到按钮（在⚙️左边）
        const signBtn = new Node('SignBtn');
        signBtn.parent = this.levelSelectPanel;
        const signBtnSize = 64;
        const signBtnUT = signBtn.addComponent(UITransform);
        signBtnUT.setContentSize(signBtnSize, signBtnSize);
        signBtnUT.setAnchorPoint(0.5, 0.5);
        this.addWidget(signBtn, {
            top: this.safeNum(this.topInset + 12, 112),
            right: this.safeNum(16 + 64 + 12, 92),
        });

        const signBtnG = signBtn.addComponent(Graphics);
        signBtnG.fillColor = this.COLOR_HUD_BAR.clone();
        signBtnG.strokeColor = this.COLOR_CARD_BORDER.clone();
        signBtnG.lineWidth = 2;
        signBtnG.circle(0, 0, signBtnSize / 2);
        signBtnG.fill();
        signBtnG.stroke();

        const signBtnLabelNode = new Node('Label');
        signBtnLabelNode.parent = signBtn;
        const signBtnLabelUT = signBtnLabelNode.addComponent(UITransform);
        signBtnLabelUT.setContentSize(signBtnSize, signBtnSize);
        const signBtnLabel = signBtnLabelNode.addComponent(Label);
        signBtnLabel.string = '📅';
        signBtnLabel.fontSize = 30;
        signBtnLabel.lineHeight = 34;
        signBtnLabel.color = this.COLOR_HUD_TEXT.clone();
        signBtnLabel.useSystemFont = true;
        signBtnLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        signBtnLabel.verticalAlign = Label.VerticalAlign.CENTER;

        const signButton = signBtn.addComponent(Button);
        signButton.transition = Button.Transition.NONE;
        signButton.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(signBtn);
            signBtn.setScale(0.95, 0.95, 1);
            tween(signBtn)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        signButton.node.on(Button.EventType.CLICK, () => this.showDailySignPanel(), this);

        this.levelSelectPanel.active = false;
    }

    /** M-A: 关卡选择页返回首页（不重置任何进度/币/图鉴/存档） */
    private onLevelSelectHome(): void {
        this.hidePanel(this.levelSelectPanel);
        this.showHomePanel();
        console.log('[GameManager] 关卡选择 → 返回首页');
    }

    /** 创建单个关卡按钮（三态由 refreshLevelSelectStates 控制） */
    private createLevelButton(parent: Node, levelIdx: number, config: LevelConfig, size: number): void {
        const node = new Node(`Lvl${config.level}`);
        node.parent = parent;
        const ut = node.addComponent(UITransform);
        ut.setContentSize(size, size);

        const bg = node.addComponent(Graphics);

        // 主标签（关卡号 / 🔒）
        const mainNode = new Node('MainLabel');
        mainNode.parent = node;
        mainNode.addComponent(UITransform).setContentSize(size, size);
        const mainLabel = mainNode.addComponent(Label);
        mainLabel.string = String(config.level);
        mainLabel.fontSize = 32;
        mainLabel.lineHeight = 36;
        mainLabel.color = Color.WHITE.clone();
        mainLabel.useSystemFont = true;
        mainLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        mainLabel.verticalAlign = Label.VerticalAlign.CENTER;
        mainLabel.overflow = Label.Overflow.NONE;
        mainNode.setPosition(0, 6, 0);

        // 副标签（⭐bestScore / ▶ / 空）
        const subNode = new Node('SubLabel');
        subNode.parent = node;
        subNode.addComponent(UITransform).setContentSize(size, 24);
        const subLabel = subNode.addComponent(Label);
        subLabel.string = '';
        subLabel.fontSize = 16;
        subLabel.lineHeight = 20;
        subLabel.color = Color.WHITE.clone();
        subLabel.useSystemFont = true;
        subLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        subLabel.verticalAlign = Label.VerticalAlign.CENTER;
        subLabel.overflow = Label.Overflow.NONE;
        subNode.setPosition(0, -28, 0);

        // Boss 标识（静态，仅 Boss 关显示）
        if (config.isBoss) {
            const bossNode = new Node('BossBadge');
            bossNode.parent = node;
            bossNode.addComponent(UITransform).setContentSize(size, 20);
            const bossLabel = bossNode.addComponent(Label);
            bossLabel.string = '⭐BOSS';
            bossLabel.fontSize = 14;
            bossLabel.lineHeight = 18;
            bossLabel.isBold = true;
            bossLabel.color = Color.WHITE.clone();
            // ★ I1: 金色描边让 Boss 更醒目
            bossLabel.enableOutline = true;
            bossLabel.outlineColor = this.COLOR_CHAPTER_GOLD.clone();
            bossLabel.outlineWidth = 3;
            bossLabel.useSystemFont = true;
            bossLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
            bossLabel.verticalAlign = Label.VerticalAlign.CENTER;
            bossLabel.overflow = Label.Overflow.NONE;
            // BOSS 标识移到格子上方外侧，不与锁图标/关号重叠
            const badgeY = this.safeNum(size / 2 + 9, 59);
            bossNode.setPosition(0, badgeY, 0);
        }

        // Button SCALE 反馈
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.duration = 0.1;
        button.zoomScale = 0.92;
        button.node.on(Button.EventType.CLICK, () => this.onLevelButtonClick(levelIdx), this);

        // 存储引用（供 refresh 使用）
        this.levelSelectBtns[levelIdx] = { node, bg, mainLabel, subLabel };
    }

    /** 从 SaveManager 刷新所有关卡按钮的三态显示 */
    private refreshLevelSelectStates(): void {
        const maxUnlocked = SaveManager.inst.getMaxUnlocked();
        const size = 100;

        // ★ I1: 停止所有关卡按钮上的脉冲 tween（切页/刷新时清理）
        for (const btn of this.levelSelectBtns) {
            if (btn) Tween.stopAllByTarget(btn.node);
        }

        for (let i = 0; i < this.levelConfigs.length; i++) {
            const btn = this.levelSelectBtns[i];
            if (!btn) continue;

            const config = this.levelConfigs[i];
            const levelNum = config.level; // 1-based
            const isCleared = SaveManager.inst.isCleared(levelNum);
            const isCurrent = (levelNum === maxUnlocked) && !isCleared;
            const isLocked = levelNum > maxUnlocked;

            // 重绘背景
            btn.bg.clear();
            if (isLocked) {
                btn.bg.fillColor = this.COLOR_LEVEL_LOCKED.clone();
                btn.bg.strokeColor = new Color(0, 0, 0, 25);
            } else if (isCurrent) {
                // ★ I1: 当前关用金色底 + 金色描边呼吸提示
                btn.bg.fillColor = this.COLOR_BTN_AD.clone();
                btn.bg.strokeColor = this.COLOR_CHAPTER_GOLD.clone();
                btn.bg.lineWidth = 4;
            } else if (config.isBoss && isCleared) {
                // ★ I1: 已通关 Boss 关用金色底
                btn.bg.fillColor = this.COLOR_CHAPTER_GOLD.clone();
                btn.bg.strokeColor = new Color(0, 0, 0, 40);
            } else {
                // 已通关普通：紫色
                btn.bg.fillColor = this.COLOR_BTN_PRIMARY.clone();
                btn.bg.strokeColor = new Color(0, 0, 0, 40);
            }
            btn.bg.lineWidth = isCurrent ? 4 : 2;
            btn.bg.roundRect(-size / 2, -size / 2, size, size, 16);
            btn.bg.fill();
            btn.bg.stroke();

            // 主标签
            if (isLocked) {
                btn.mainLabel.string = '🔒';
                btn.mainLabel.color = this.COLOR_LEVEL_LOCKED_TEXT.clone();
            } else {
                btn.mainLabel.string = String(levelNum);
                btn.mainLabel.color = Color.WHITE.clone();
            }

            // 副标签
            if (isCleared) {
                const best = SaveManager.inst.getBestScore(levelNum);
                btn.subLabel.string = `⭐${best}`;
                btn.subLabel.color = Color.WHITE.clone();
            } else if (isCurrent) {
                btn.subLabel.string = '▶';
                btn.subLabel.color = Color.WHITE.clone();
            } else {
                btn.subLabel.string = '';
            }

            // 可点性
            btn.node.getComponent(Button)!.interactable = !isLocked;

            // ★ I1: 当前关轻脉冲呼吸（scale 1→1.06→1 循环 0.9s）
            btn.node.setScale(1, 1, 1);
            if (isCurrent) {
                tween(btn.node)
                    .to(0.45, { scale: new Vec3(1.06, 1.06, 1) }, { easing: 'sineOut' })
                    .to(0.45, { scale: new Vec3(1, 1, 1) }, { easing: 'sineIn' })
                    .union()
                    .repeatForever()
                    .start();
            }
        }

        // B: 刷新资源徽章
        const coins = SaveManager.inst.getCoins();
        let collectedCount = 0;
        for (let i = 0; i < 6; i++) {
            if (SaveManager.inst.getMonster(i).count > 0) collectedCount++;
        }
        if (this.levelSelectCoinBadge) {
            this.levelSelectCoinBadge.string = `🎲 ${this.safeNum(coins, 0)}`;
        }
        if (this.levelSelectCollectionBadge) {
            this.levelSelectCollectionBadge.string = `📖 图鉴 ${collectedCount}/6`;
        }

        console.log(`[GameManager] 关卡选择页已刷新: maxUnlocked=${maxUnlocked}`);
    }

    /** 显示关卡选择页（刷新状态 + 弹出动画） */
    private showLevelSelectPanel(): void {
        if (!this.levelSelectPanel) return;
        this.refreshLevelSelectStates();
        this._inLevel = false;
        this.showPanel(this.levelSelectPanel);
        // 选择页全屏覆盖 → 隐藏游戏圈按钮
        this.gameClubEntry?.hide();

        // R3: 当天未签 → 自动弹出签到面板（仅一次）
        try {
            if (!this.dailySignHasShownToday) {
                const today = this.getTodayStr();
                const signData = SaveManager.inst.getSignData();
                if (signData.lastDate !== today) {
                    this.dailySignHasShownToday = true;
                    this.scheduleOnce(() => this.showDailySignPanel(), 0.4);
                }
            }
        } catch (e) { /* ignore */ }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  首页层（F0）
    // ══════════════════════════════════════════════════════════════════════════

    private createHomePanel(): void {
        this.homePanel = new Node('HomePanel');
        this.homePanel.parent = this.node.parent!;
        const panelUT = this.homePanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.homePanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // ── 背景层：先画降级渐变底（保证不黑屏），再异步加载背景图覆盖 ──
        // 渐变底（兜底，最底层）
        const bgNode = new Node('HomeBg');
        bgNode.parent = this.homePanel;
        bgNode.setSiblingIndex(0); // 永远在首页层最底
        const bgUT = bgNode.addComponent(UITransform);
        bgUT.setContentSize(pw, ph);
        bgUT.setAnchorPoint(0.5, 0.5);
        bgNode.setPosition(0, 0, 0);

        // 降级渐变底（复用现有配色）
        const bgG = bgNode.addComponent(Graphics);
        const segH = this.safeNum(ph / 3, 400);
        bgG.fillColor = new Color(0xCD, 0xB8, 0xCE);
        bgG.rect(-pw / 2, segH, pw, segH);
        bgG.fill();
        bgG.fillColor = new Color(0xE4, 0xD2, 0xE2);
        bgG.rect(-pw / 2, 0, pw, segH);
        bgG.fill();
        bgG.fillColor = new Color(0xCD, 0xB8, 0xCE);
        bgG.rect(-pw / 2, -segH, pw, segH);
        bgG.fill();

        // 背景图 Sprite（在渐变之上、UI 之下）
        const bgSpriteNode = new Node('BgSprite');
        bgSpriteNode.parent = this.homePanel;
        bgSpriteNode.setSiblingIndex(1); // 紧挨渐变上方，在标题/按钮之下
        const bgSpriteUT = bgSpriteNode.addComponent(UITransform);
        bgSpriteUT.setContentSize(pw, ph);
        bgSpriteUT.setAnchorPoint(0.5, 0.5);
        bgSpriteNode.setPosition(0, 0, 0);
        this.homeBgSprite = bgSpriteNode.addComponent(Sprite);
        this.homeBgSprite.type = Sprite.Type.SIMPLE;
        this.homeBgSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        // 初始透明（等图加载完再显示）
        const bgSpriteOp = bgSpriteNode.addComponent(UIOpacity);
        bgSpriteOp.opacity = 0;

        // 异步加载背景图
        resources.load('ui/home_bg/spriteFrame', SpriteFrame, (err, frame) => {
            if (err || !frame) {
                console.warn('[HomePanel] 背景图加载失败，使用降级渐变底:', err);
                return;
            }
            if (!this.homeBgSprite || !this.homePanel || !this.homePanel.isValid) return;

            this.homeBgSprite.spriteFrame = frame;

            // Cover 铺满：按短边缩放，确保不留黑边
            const tex = frame.texture;
            const texW = this.safeNum(tex.width, pw);
            const texH = this.safeNum(tex.height, ph);
            const scale = Math.max(pw / texW, ph / texH);
            const drawW = this.safeNum(texW * scale, pw);
            const drawH = this.safeNum(texH * scale, ph);
            bgSpriteUT.setContentSize(drawW, drawH);

            // 确保背景图在渐变之上、UI 之下
            if (bgSpriteNode.isValid) {
                bgSpriteNode.setSiblingIndex(1);
            }
            // 图已铺满，关掉渐变底避免半透明叠加发灰
            if (bgNode.isValid) {
                bgNode.active = false;
            }

            // 淡入显示
            Tween.stopAllByTarget(bgSpriteOp);
            bgSpriteOp.opacity = 0;
            tween(bgSpriteOp).to(0.3, { opacity: 255 }).start();

            console.log(`[HomePanel] 背景图加载成功: ${texW}×${texH} → scale=${scale.toFixed(2)} draw=${drawW.toFixed(0)}×${drawH.toFixed(0)}`);
        });

        // ── S1: 资源总览条（只读，不可点，压在标题上方） ──
        const badgeY = this.safeNum(ph * 0.5 - ph * 0.06, 560);
        const badgeW = this.safeNum(pw * 0.4, 280);

        // 左：扭蛋币
        const coinBadgeNode = new Node('HomeCoinBadge');
        coinBadgeNode.parent = this.homePanel;
        coinBadgeNode.addComponent(UITransform).setContentSize(badgeW, 36);
        coinBadgeNode.setPosition(this.safeNum(-pw * 0.22, -158), badgeY, 0);
        this.homeCoinBadge = coinBadgeNode.addComponent(Label);
        this.homeCoinBadge.string = '';
        this.homeCoinBadge.fontSize = 26;
        this.homeCoinBadge.lineHeight = 30;
        this.homeCoinBadge.color = Color.WHITE.clone();
        this.homeCoinBadge.useSystemFont = true;
        this.homeCoinBadge.isBold = true;
        this.homeCoinBadge.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.homeCoinBadge.verticalAlign = Label.VerticalAlign.CENTER;
        this.homeCoinBadge.overflow = Label.Overflow.SHRINK;
        this.homeCoinBadge.enableOutline = true;
        this.homeCoinBadge.outlineColor = new Color(0x4A, 0x2B, 0x6B, 255);
        this.homeCoinBadge.outlineWidth = 3;

        // 右：图鉴进度
        const collBadgeNode = new Node('HomeCollectionBadge');
        collBadgeNode.parent = this.homePanel;
        collBadgeNode.addComponent(UITransform).setContentSize(badgeW, 36);
        collBadgeNode.setPosition(this.safeNum(pw * 0.22, 158), badgeY, 0);
        this.homeCollectionBadge = collBadgeNode.addComponent(Label);
        this.homeCollectionBadge.string = '';
        this.homeCollectionBadge.fontSize = 26;
        this.homeCollectionBadge.lineHeight = 30;
        this.homeCollectionBadge.color = Color.WHITE.clone();
        this.homeCollectionBadge.useSystemFont = true;
        this.homeCollectionBadge.isBold = true;
        this.homeCollectionBadge.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.homeCollectionBadge.verticalAlign = Label.VerticalAlign.CENTER;
        this.homeCollectionBadge.overflow = Label.Overflow.SHRINK;
        this.homeCollectionBadge.enableOutline = true;
        this.homeCollectionBadge.outlineColor = new Color(0x4A, 0x2B, 0x6B, 255);
        this.homeCollectionBadge.outlineWidth = 3;

        // ── 标题层（引擎渲染，不依赖背景图文字） ──
        const titleNode = new Node('Title');
        titleNode.parent = this.homePanel;
        titleNode.addComponent(UITransform).setContentSize(pw, 100);
        const titleLabel = titleNode.addComponent(Label);
        titleLabel.string = '消消萌盒';
        titleLabel.fontSize = 64;
        titleLabel.lineHeight = 72;
        titleLabel.isBold = true;
        titleLabel.color = Color.WHITE.clone();
        titleLabel.useSystemFont = true;
        titleLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        titleLabel.verticalAlign = Label.VerticalAlign.CENTER;
        titleLabel.overflow = Label.Overflow.NONE;
        // 深紫描边保证压在浅底上清晰
        titleLabel.enableOutline = true;
        titleLabel.outlineColor = new Color(0x4A, 0x2B, 0x6B, 255);
        titleLabel.outlineWidth = 4;
        // 标题居中偏上（屏幕上方 ~15% 区）
        const titleY = this.safeNum(ph * 0.5 - ph * 0.15, 400);
        titleNode.setPosition(0, titleY, 0);

        // Slogan
        const sloganNode = new Node('Slogan');
        sloganNode.parent = this.homePanel;
        sloganNode.addComponent(UITransform).setContentSize(pw, 40);
        const sloganLabel = sloganNode.addComponent(Label);
        sloganLabel.string = '消一消，攒一窝软萌公仔';
        sloganLabel.fontSize = 26;
        sloganLabel.lineHeight = 32;
        sloganLabel.color = Color.WHITE.clone();
        sloganLabel.useSystemFont = true;
        sloganLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        sloganLabel.verticalAlign = Label.VerticalAlign.CENTER;
        sloganLabel.overflow = Label.Overflow.NONE;
        sloganLabel.enableOutline = true;
        sloganLabel.outlineColor = new Color(0x4A, 0x2B, 0x6B, 200);
        sloganLabel.outlineWidth = 2;
        sloganNode.setPosition(0, this.safeNum(titleY - 60, 340), 0);

        // ── 开始按钮（暖金实心，居中偏下） ──
        const startBtn = this.createRoundButton(this.homePanel, 'StartBtn', '▶  开始游戏',
            this.COLOR_BTN_AD, 320, 90, () => this.onHomeStartClick());
        const startY = this.safeNum(-ph * 0.2, -200);
        startBtn.setPosition(0, startY, 0);

        // S2: 「继续 L{n}」ghost 按钮钮（在开始按钮下方）
        this.homeContinueBtn = this.createRoundButton(this.homePanel, 'ContinueBtn', '',
            this.COLOR_BTN_PRIMARY, 280, 64, () => this.onHomeContinueClick(),
            { ghost: true });
        this.homeContinueBtn.setPosition(0, this.safeNum(startY - 110, -310), 0);
        this.homeContinueLabel = this.homeContinueBtn.getChildByName('Label')?.getComponent(Label) ?? null;

        // S3: 右上角音效/震动状态角标（可点切换）
        const badgeSize = 52;
        const badgeTop = this.safeNum(this.topInset + 12, 112);
        const badgeRightStart = this.safeNum(16, 16);

        // 音效角标
        const soundBadgeNode = new Node('HomeSoundBadge');
        soundBadgeNode.parent = this.homePanel;
        const soundBadgeUT = soundBadgeNode.addComponent(UITransform);
        soundBadgeUT.setContentSize(badgeSize, badgeSize);
        soundBadgeUT.setAnchorPoint(0.5, 0.5);
        this.addWidget(soundBadgeNode, { top: badgeTop, right: badgeRightStart });
        const soundBadgeBg = soundBadgeNode.addComponent(Graphics);
        soundBadgeBg.fillColor = this.COLOR_HUD_BAR.clone();
        soundBadgeBg.strokeColor = this.COLOR_CARD_BORDER.clone();
        soundBadgeBg.lineWidth = 2;
        soundBadgeBg.circle(0, 0, badgeSize / 2);
        soundBadgeBg.fill();
        soundBadgeBg.stroke();
        const soundBadgeLabelNode = new Node('Label');
        soundBadgeLabelNode.parent = soundBadgeNode;
        soundBadgeLabelNode.addComponent(UITransform).setContentSize(badgeSize, badgeSize);
        this.homeSoundBadge = soundBadgeLabelNode.addComponent(Label);
        this.homeSoundBadge.string = '🔊';
        this.homeSoundBadge.fontSize = 24;
        this.homeSoundBadge.lineHeight = 28;
        this.homeSoundBadge.color = this.COLOR_HUD_TEXT.clone();
        this.homeSoundBadge.useSystemFont = true;
        this.homeSoundBadge.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.homeSoundBadge.verticalAlign = Label.VerticalAlign.CENTER;
        const soundBadgeBtn = soundBadgeNode.addComponent(Button);
        soundBadgeBtn.transition = Button.Transition.NONE;
        soundBadgeBtn.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(soundBadgeNode);
            soundBadgeNode.setScale(0.9, 0.9, 1);
            tween(soundBadgeNode)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        soundBadgeBtn.node.on(Button.EventType.CLICK, () => this.onHomeSoundToggle(), this);

        // 震动角标（在音效角标左边）
        const vibrateBadgeNode = new Node('HomeVibrateBadge');
        vibrateBadgeNode.parent = this.homePanel;
        const vibrateBadgeUT = vibrateBadgeNode.addComponent(UITransform);
        vibrateBadgeUT.setContentSize(badgeSize, badgeSize);
        vibrateBadgeUT.setAnchorPoint(0.5, 0.5);
        this.addWidget(vibrateBadgeNode, { top: badgeTop, right: this.safeNum(badgeRightStart + badgeSize + 10, 78) });
        const vibrateBadgeBg = vibrateBadgeNode.addComponent(Graphics);
        vibrateBadgeBg.fillColor = this.COLOR_HUD_BAR.clone();
        vibrateBadgeBg.strokeColor = this.COLOR_CARD_BORDER.clone();
        vibrateBadgeBg.lineWidth = 2;
        vibrateBadgeBg.circle(0, 0, badgeSize / 2);
        vibrateBadgeBg.fill();
        vibrateBadgeBg.stroke();
        const vibrateBadgeLabelNode = new Node('Label');
        vibrateBadgeLabelNode.parent = vibrateBadgeNode;
        vibrateBadgeLabelNode.addComponent(UITransform).setContentSize(badgeSize, badgeSize);
        this.homeVibrateBadge = vibrateBadgeLabelNode.addComponent(Label);
        this.homeVibrateBadge.string = '📳';
        this.homeVibrateBadge.fontSize = 24;
        this.homeVibrateBadge.lineHeight = 28;
        this.homeVibrateBadge.color = this.COLOR_HUD_TEXT.clone();
        this.homeVibrateBadge.useSystemFont = true;
        this.homeVibrateBadge.horizontalAlign = Label.HorizontalAlign.CENTER;
        this.homeVibrateBadge.verticalAlign = Label.VerticalAlign.CENTER;
        const vibrateBadgeBtn = vibrateBadgeNode.addComponent(Button);
        vibrateBadgeBtn.transition = Button.Transition.NONE;
        vibrateBadgeBtn.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(vibrateBadgeNode);
            vibrateBadgeNode.setScale(0.9, 0.9, 1);
            tween(vibrateBadgeNode)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        vibrateBadgeBtn.node.on(Button.EventType.CLICK, () => this.onHomeVibrateToggle(), this);

        // S3: 角标置顶
        soundBadgeNode.setSiblingIndex(this.homePanel.children.length - 1);
        vibrateBadgeNode.setSiblingIndex(this.homePanel.children.length - 1);

        // 拦截底层触摸
        let blockInput = this.homePanel.getComponent(BlockInputEvents);
        if (!blockInput) {
            blockInput = this.homePanel.addComponent(BlockInputEvents);
        }

        this.homePanel.active = false;
    }

    /** 显示首页层 */
    private showHomePanel(): void {
        if (!this.homePanel) return;
        this.homePanel.active = true;
        // 置于最上层
        const parent = this.homePanel.parent;
        if (parent) {
            this.homePanel.setSiblingIndex(parent.children.length - 1);
        }
        // 确保 BlockInputEvents 启用
        const blockInput = this.homePanel.getComponent(BlockInputEvents);
        if (blockInput) blockInput.enabled = true;

        // S1: 刷新资源总览条
        try {
            if (this.homeCoinBadge && this.homeCoinBadge.isValid) {
                const coins = this.safeNum(SaveManager.inst.getCoins(), 0);
                this.homeCoinBadge.string = `🎲 ${coins}`;
            }
            if (this.homeCollectionBadge && this.homeCollectionBadge.isValid) {
                let owned = 0;
                for (let i = 0; i < 6; i++) {
                    if (this.safeNum(SaveManager.inst.getMonster(i).count, 0) > 0) owned++;
                }
                this.homeCollectionBadge.string = `📖 图鉴 ${owned}/6`;
            }
        } catch (e) { /* ignore */ }

        // S2: 刷新「继续 L{n}」按钮关号
        try {
            if (this.homeContinueLabel && this.homeContinueLabel.isValid) {
                const maxUnlocked = this.safeNum(SaveManager.inst.getMaxUnlocked(), 1);
                this.homeContinueLabel.string = `▶ 继续 L${maxUnlocked}`;
            }
        } catch (e) { /* ignore */ }

        // S3: 刷新音效/震动角标
        try {
            if (this.homeSoundBadge && this.homeSoundBadge.isValid) {
                const soundOn = SaveManager.inst.getSoundEnabled();
                this.homeSoundBadge.string = soundOn ? '🔊' : '🔇';
            }
            if (this.homeVibrateBadge && this.homeVibrateBadge.isValid) {
                const vibrateOn = SaveManager.inst.getVibrateEnabled();
                this.homeVibrateBadge.string = vibrateOn ? '📳' : '🚫';
            }
        } catch (e) { /* ignore */ }

        this.gameClubEntry?.hide();
        console.log('[GameManager] 显示首页');
    }

    /** S3: 首页音效角标点击切换 */
    private onHomeSoundToggle(): void {
        try {
            const current = SaveManager.inst.getSoundEnabled();
            const newVal = !current;
            AudioManager.inst?.setEnabled(newVal); // 内部已写盘
            if (this.homeSoundBadge && this.homeSoundBadge.isValid) {
                this.homeSoundBadge.string = newVal ? '🔊' : '🔇';
            }
            console.log(`[Home] 音效 → ${newVal ? 'ON' : 'OFF'}`);
        } catch (e) { /* ignore */ }
    }

    /** S3: 首页震动角标点击切换 */
    private onHomeVibrateToggle(): void {
        try {
            const current = SaveManager.inst.getVibrateEnabled();
            const newVal = !current;
            VibrateManager.inst?.setVibrateEnabled(newVal);
            SaveManager.inst.setVibrateEnabled(newVal);
            if (this.homeVibrateBadge && this.homeVibrateBadge.isValid) {
                this.homeVibrateBadge.string = newVal ? '📳' : '🚫';
            }
            console.log(`[Home] 震动 → ${newVal ? 'ON' : 'OFF'}`);
        } catch (e) { /* ignore */ }
    }

    /** 首页开始按钮 → 隐藏首页 → 进关卡选择页 */
    private onHomeStartClick(): void {
        if (this.homePanel) {
            this.homePanel.active = false;
            const blockInput = this.homePanel.getComponent(BlockInputEvents);
            if (blockInput) blockInput.enabled = false;
        }
        this.showLevelSelectPanel();
        console.log('[GameManager] 开始游戏 → 进入关卡选择');
    }

    /** S2: 首页「继续上次」→ 隐藏首页 → 直接进当前最高可玩关 */
    private onHomeContinueClick(): void {
        if (this.homePanel) {
            this.homePanel.active = false;
            const blockInput = this.homePanel.getComponent(BlockInputEvents);
            if (blockInput) blockInput.enabled = false;
        }
        const maxUnlocked = this.safeNum(SaveManager.inst.getMaxUnlocked(), 1);
        const levelIdx = Math.max(0, Math.min(maxUnlocked - 1, this.levelConfigs.length - 1));
        this.startLevel(levelIdx);
        console.log(`[GameManager] 继续上次 → 直接进关 L${maxUnlocked}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  抽卡页（E2）
    // ══════════════════════════════════════════════════════════════════════════

    private createGachaPanel(): void {
        this.gachaPanel = new Node('GachaPanel');
        this.gachaPanel.parent = this.node.parent!;
        const panelUT = this.gachaPanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.gachaPanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask
        const maskNode = new Node('Mask');
        maskNode.parent = this.gachaPanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 160);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity);
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card
        const cardW = 560, cardH = 680;
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.gachaPanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(-(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2, cardW + sPad * 2, cardH + sPad * 2, 28 + sPad);
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: 0 });

        const card = new Node('Card');
        card.parent = this.gachaPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 0 });
        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        // Layout
        const cardLayout = card.addComponent(Layout);
        cardLayout.type = Layout.Type.VERTICAL;
        cardLayout.spacingY = 20;
        cardLayout.paddingTop = 36;
        cardLayout.paddingBottom = 36;
        cardLayout.horizontalDirection = Layout.HorizontalDirection.CENTER;
        cardLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
        cardLayout.resizeMode = Layout.ResizeMode.NONE;

        // Title
        const titleLabel = this.createLabel(card, 'Title', '🎲 扭蛋机', 44, this.COLOR_TITLE_WIN);
        titleLabel.isBold = true;
        const titleW = this.safeNum(cardW - 80, 440);
        titleLabel.node.getComponent(UITransform)!.setContentSize(titleW, 56);
        titleLabel.overflow = Label.Overflow.SHRINK;
        titleLabel.enableWrapText = false;

        // Coin balance
        this.gachaCoinLabel = this.createLabel(card, 'CoinBalance', '', 32, this.COLOR_CHAPTER_GOLD);
        this.gachaCoinLabel.isBold = true;
        const coinW = this.safeNum(cardW - 80, 440);
        this.gachaCoinLabel.node.getComponent(UITransform)!.setContentSize(coinW, 44);
        this.gachaCoinLabel.overflow = Label.Overflow.SHRINK;
        this.gachaCoinLabel.enableWrapText = false;

        // Result display area (placeholder, hidden until pull)
        this.gachaResultNode = new Node('ResultArea');
        this.gachaResultNode.parent = card;
        const resultUT = this.gachaResultNode.addComponent(UITransform);
        resultUT.setContentSize(this.safeNum(cardW - 80, 440), 200);

        // Result emoji (big)
        this.gachaResultEmoji = this.createLabel(this.gachaResultNode, 'ResultEmoji', '', 80, Color.WHITE);
        this.gachaResultEmoji.node.getComponent(UITransform)!.setContentSize(200, 120);
        this.gachaResultEmoji.overflow = Label.Overflow.NONE;
        this.gachaResultEmoji.node.setPosition(0, 30, 0);

        // Result rarity label
        this.gachaResultRarity = this.createLabel(this.gachaResultNode, 'ResultRarity', '', 28, this.COLOR_RARITY_R);
        this.gachaResultRarity.isBold = true;
        this.gachaResultRarity.node.getComponent(UITransform)!.setContentSize(200, 36);
        this.gachaResultRarity.overflow = Label.Overflow.NONE;
        this.gachaResultRarity.node.setPosition(0, -30, 0);

        // NEW! label
        this.gachaResultNew = this.createLabel(this.gachaResultNode, 'ResultNew', '', 24, this.COLOR_RARITY_SSR);
        this.gachaResultNew.isBold = true;
        this.gachaResultNew.node.getComponent(UITransform)!.setContentSize(200, 28);
        this.gachaResultNew.overflow = Label.Overflow.NONE;
        this.gachaResultNew.node.setPosition(0, -60, 0);
        this.gachaResultNew.node.active = false;

        this.gachaResultNode.active = false;

        // Single pull button (100 coins)
        this.gachaPullBtn = this.createRoundButton(card, 'PullBtn', '单抽（100 🎲）',
            this.COLOR_BTN_PRIMARY, 440, 80, () => this.doSinglePull(false));
        this.gachaPullLabel = this.gachaPullBtn.getChildByName('Label')!.getComponent(Label)!;

        // Ad free pull button
        this.gachaAdBtn = this.createRoundButton(card, 'AdPullBtn', '▶  看广告·免费单抽',
            this.COLOR_BTN_AD, 440, 80, () => this.doSinglePull(true));
        this.gachaAdLabel = this.gachaAdBtn.getChildByName('Label')!.getComponent(Label)!;

        // Back button
        this.createRoundButton(card, 'BackBtn', '返回',
            this.COLOR_BTN_GIVEUP, 440, 64, () => this.onGachaBack(),
            { ghost: true });

        this.gachaPanel.active = false;
    }

    /** Refresh gacha panel: coin balance + button availability */
    private refreshGachaPanel(): void {
        const coins = SaveManager.inst.getCoins();
        if (this.gachaCoinLabel) {
            this.gachaCoinLabel.string = `余额: ${this.safeNum(coins, 0)} 🎲`;
        }
        const canPull = coins >= 100;
        if (this.gachaPullBtn) {
            this.gachaPullBtn.getComponent(Button)!.interactable = canPull;
        }
        if (this.gachaPullLabel) {
            this.gachaPullLabel.color = canPull ? Color.WHITE.clone() : new Color(0x99, 0x99, 0x99);
        }
    }

    /** Show gacha panel */
    private showGachaPanel(): void {
        if (!this.gachaPanel) return;
        this.refreshGachaPanel();
        if (this.gachaResultNode) this.gachaResultNode.active = false;
        // C: 清理上一次抽卡光效
        if (this.gachaGlowNode) {
            Tween.stopAllByTarget(this.gachaGlowNode);
            if (this.gachaGlowNode.isValid) this.gachaGlowNode.destroy();
            this.gachaGlowNode = null;
        }
        this.showPanel(this.gachaPanel);
        this.gameClubEntry?.hide();
    }

    /** Gacha back button */
    private onGachaBack(): void {
        this.hidePanel(this.gachaPanel);
        this.showLevelSelectPanel();
    }

    /**
     * Single pull logic.
     * @param fromAd  true = ad free pull (no coin cost), false = spend 100 coins
     */
    private doSinglePull(fromAd: boolean): void {
        if (this.gachaPulling) return;
        this.gachaPulling = true;

        const doPull = () => {
            if (!fromAd) {
                if (!SaveManager.inst.spendCoins(100)) {
                    console.log('[Gacha] 币不足，无法抽卡');
                    this.gachaPulling = false;
                    return;
                }
            }

            // Roll rarity: R 70%, SR 25%, SSR 5%
            const roll = Math.random();
            let rarity: 'R' | 'SR' | 'SSR';
            let monId: number;

            if (roll < 0.70) {
                rarity = 'R';
                monId = Math.floor(Math.random() * 3); // 0,1,2
            } else if (roll < 0.95) {
                rarity = 'SR';
                monId = 3 + Math.floor(Math.random() * 2); // 3,4
            } else {
                rarity = 'SSR';
                monId = 5;
            }

            // Safe guard
            monId = this.safeNum(monId, 0);
            if (monId < 0 || monId > 5) monId = 0;

            // Check if first time
            const before = SaveManager.inst.getMonster(monId);
            const isNew = before.count === 0;

            // Add monster
            SaveManager.inst.addMonster(monId);

            // Show result
            this.showGachaResult(monId, rarity, isNew);
            this.refreshGachaPanel();
            this.gachaPulling = false;

            console.log(`[Gacha] ${fromAd ? '广告' : '币'}抽卡 → ${rarity} monId=${monId} (${COLOR_EMOJI_MAP[monId]}) ${isNew ? 'NEW!' : ''}`);
        };

        if (fromAd) {
            // Disable button during ad
            if (this.gachaAdBtn) this.gachaAdBtn.getComponent(Button)!.interactable = false;
            if (this.gachaAdLabel) this.gachaAdLabel.string = '广告加载中...';

            AdManager.getInstance().showRewardedAd(
                () => {
                    // Reward: free pull
                    if (this.gachaAdBtn) this.gachaAdBtn.getComponent(Button)!.interactable = true;
                    if (this.gachaAdLabel) this.gachaAdLabel.string = '▶  看广告·免费单抽';
                    doPull();
                },
                () => {
                    // Ad not completed
                    if (this.gachaAdBtn) this.gachaAdBtn.getComponent(Button)!.interactable = true;
                    if (this.gachaAdLabel) this.gachaAdLabel.string = '▶  看广告·免费单抽';
                    this.gachaPulling = false;
                    console.log('[Gacha] 广告未看完，不抽卡');
                },
            );
        } else {
            doPull();
        }
    }

    /** Show gacha result with animation */
    private showGachaResult(monId: number, rarity: 'R' | 'SR' | 'SSR', isNew: boolean): void {
        if (!this.gachaResultNode || !this.gachaResultEmoji || !this.gachaResultRarity || !this.gachaResultNew) return;

        // C: 清理上一次光效
        if (this.gachaGlowNode) {
            Tween.stopAllByTarget(this.gachaGlowNode);
            if (this.gachaGlowNode.isValid) this.gachaGlowNode.destroy();
            this.gachaGlowNode = null;
        }

        const emoji = COLOR_EMOJI_MAP[monId] ?? '?';
        this.gachaResultEmoji.string = emoji;

        // Rarity label color
        let rarityColor: Color;
        let peakScale = 1.2; // C: SSR 用更大弹入
        switch (rarity) {
            case 'SSR': rarityColor = this.COLOR_RARITY_SSR.clone(); peakScale = 1.4; break;
            case 'SR': rarityColor = this.COLOR_RARITY_SR.clone(); break;
            default: rarityColor = this.COLOR_RARITY_R.clone(); break;
        }
        this.gachaResultRarity.string = rarity;
        this.gachaResultRarity.color = rarityColor;

        // NEW!
        this.gachaResultNew.node.active = isNew;

        // C: 创建稀有度光效（置于 emoji 之下层）
        const glowNode = new Node('GachaGlow');
        glowNode.parent = this.gachaResultNode;
        glowNode.setSiblingIndex(0); // 最底层
        glowNode.setPosition(0, 30, 0); // 与 emoji 同位
        const glowUT = glowNode.addComponent(UITransform);
        glowUT.setContentSize(180, 180);
        const glowG = glowNode.addComponent(Graphics);
        const glowOp = glowNode.addComponent(UIOpacity);
        glowOp.opacity = 255;

        const safeId = this.safeNum(monId, 0);
        const effRarity = (safeId >= 0 && safeId <= 5) ? (MON_RARITY[safeId] ?? 'R') : 'R';

        if (effRarity === 'SSR') {
            // 金色光环 + 旋转星芒
            glowG.fillColor = new Color(rarityColor.r, rarityColor.g, rarityColor.b, 50);
            glowG.circle(0, 0, 80);
            glowG.fill();
            glowG.strokeColor = new Color(rarityColor.r, rarityColor.g, rarityColor.b, 200);
            glowG.lineWidth = 4;
            glowG.circle(0, 0, 75);
            glowG.stroke();
            // 星芒射线
            glowG.strokeColor = new Color(rarityColor.r, rarityColor.g, rarityColor.b, 140);
            glowG.lineWidth = 3;
            for (let i = 0; i < 8; i++) {
                const angle = (i / 8) * Math.PI * 2;
                glowG.moveTo(Math.cos(angle) * 30, Math.sin(angle) * 30);
                glowG.lineTo(Math.cos(angle) * 88, Math.sin(angle) * 88);
            }
            glowG.stroke();
            // 旋转
            tween(glowNode)
                .by(3, { angle: 360 })
                .repeatForever()
                .start();
            // 呼吸
            tween(glowOp)
                .to(0.6, { opacity: 170 })
                .to(0.6, { opacity: 255 })
                .union()
                .repeatForever()
                .start();
        } else if (effRarity === 'SR') {
            // 银蓝柔光环 + 轻微脉冲
            glowG.fillColor = new Color(rarityColor.r, rarityColor.g, rarityColor.b, 35);
            glowG.circle(0, 0, 75);
            glowG.fill();
            glowG.strokeColor = new Color(rarityColor.r, rarityColor.g, rarityColor.b, 110);
            glowG.lineWidth = 3;
            glowG.circle(0, 0, 70);
            glowG.stroke();
            tween(glowOp)
                .to(0.8, { opacity: 140 })
                .to(0.8, { opacity: 255 })
                .union()
                .repeatForever()
                .start();
        } else {
            // R: 淡糖色柔光
            glowG.fillColor = new Color(0xFF, 0xE0, 0xB0, 25);
            glowG.circle(0, 0, 65);
            glowG.fill();
        }

        this.gachaGlowNode = glowNode;

        // Show + animate (scale 0→peak→1)，C: SSR 用 peakScale=1.4
        this.gachaResultNode.active = true;
        this.gachaResultNode.setScale(0, 0, 1);
        Tween.stopAllByTarget(this.gachaResultNode);
        tween(this.gachaResultNode)
            .to(0.25, { scale: new Vec3(peakScale, peakScale, 1) }, { easing: 'backOut' })
            .to(0.1, { scale: new Vec3(1, 1, 1) })
            .start();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  图鉴页（E3）
    // ══════════════════════════════════════════════════════════════════════════

    private createCollectionPanel(): void {
        this.collectionPanel = new Node('CollectionPanel');
        this.collectionPanel.parent = this.node.parent!;
        const panelUT = this.collectionPanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.collectionPanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask
        const maskNode = new Node('Mask');
        maskNode.parent = this.collectionPanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 160);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity);
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card（Q-fix: cardH 860→932，增高 72 以容纳装扮按钮行）
        const cardW = 640, cardH = 932;
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.collectionPanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(-(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2, cardW + sPad * 2, cardH + sPad * 2, 28 + sPad);
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: 0 });

        const card = new Node('Card');
        card.parent = this.collectionPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 0 });
        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        // ── 手动定位（不用 Layout.CONTAINER，避免真机 update 时机不稳）──
        const padding = 32;
        const spacing = 14;

        // 各子节点高度
        const titleH = 56;
        const compH = 36;
        const groupTitleH = 36;
        const rowH = 130;   // cellSize
        const backH = 64;
        const dressupH = 56;
        const btnGap = 16;           // 装扮与返回之间的间距
        const backBottomMargin = 40; // 返回按钮距卡片底部留白

        // 从卡片顶部开始，逐项往下排
        let cursorY = this.safeNum(cardH / 2 - padding, 400);

        // Title
        const titleLabel = this.createLabel(card, 'Title', '📖 图鉴', 44, this.COLOR_TITLE_WIN);
        titleLabel.isBold = true;
        const titleW = this.safeNum(cardW - 80, 560);
        titleLabel.node.getComponent(UITransform)!.setContentSize(titleW, titleH);
        titleLabel.overflow = Label.Overflow.SHRINK;
        titleLabel.enableWrapText = false;
        cursorY = this.safeNum(cursorY - titleH / 2, 0);
        titleLabel.node.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - titleH / 2 - spacing, 0);

        // Completion label
        this.collectionCompletionLabel = this.createLabel(card, 'Completion', '', 28, this.COLOR_HUD_TEXT);
        const compW = this.safeNum(cardW - 80, 560);
        this.collectionCompletionLabel.node.getComponent(UITransform)!.setContentSize(compW, compH);
        this.collectionCompletionLabel.overflow = Label.Overflow.SHRINK;
        this.collectionCompletionLabel.enableWrapText = false;
        cursorY = this.safeNum(cursorY - compH / 2, 0);
        this.collectionCompletionLabel.node.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - compH / 2 - spacing, 0);

        // 3 rarity groups: R(0,1,2), SR(3,4), SSR(5)
        const groups = [
            { name: 'R', color: this.COLOR_RARITY_R, ids: [0, 1, 2] },
            { name: 'SR', color: this.COLOR_RARITY_SR, ids: [3, 4] },
            { name: 'SSR', color: this.COLOR_RARITY_SSR, ids: [5] },
        ];
        const cellSize = 130;
        const cellGap = 12;

        for (const group of groups) {
            // Group title
            const groupTitle = this.createLabel(card, `Group${group.name}`, group.name, 28, group.color);
            groupTitle.isBold = true;
            const gtW = this.safeNum(cardW - 80, 560);
            groupTitle.node.getComponent(UITransform)!.setContentSize(gtW, groupTitleH);
            groupTitle.overflow = Label.Overflow.SHRINK;
            groupTitle.enableWrapText = false;
            cursorY = this.safeNum(cursorY - groupTitleH / 2, 0);
            groupTitle.node.setPosition(0, cursorY, 0);
            cursorY = this.safeNum(cursorY - groupTitleH / 2 - spacing, 0);

            // Row container
            const rowNode = new Node(`Row${group.name}`);
            rowNode.parent = card;
            const colCount = group.ids.length;
            const rowW = this.safeNum(colCount * cellSize + (colCount - 1) * cellGap, 400);
            rowNode.addComponent(UITransform).setContentSize(rowW, rowH);

            const rowLayout = rowNode.addComponent(Layout);
            rowLayout.type = Layout.Type.HORIZONTAL;
            rowLayout.spacingX = cellGap;
            rowLayout.horizontalDirection = Layout.HorizontalDirection.LEFT_TO_RIGHT;
            rowLayout.verticalDirection = Layout.VerticalDirection.CENTER;
            rowLayout.resizeMode = Layout.ResizeMode.NONE;

            // Create cells
            for (const monId of group.ids) {
                this.createCollectionCell(rowNode, monId, cellSize);
            }

            cursorY = this.safeNum(cursorY - rowH / 2, 0);
            rowNode.setPosition(0, cursorY, 0);
            cursorY = this.safeNum(cursorY - rowH / 2 - spacing, 0);
        }

        // ── 返回按钮：钉在卡片底部（距底 40）──
        const backBtn = this.createRoundButton(card, 'BackBtn', '返回',
            this.COLOR_BTN_GIVEUP, 440, backH, () => this.onCollectionBack(),
            { ghost: true });

        // 强制更新世界变换，实测卡片 BBox
        card.updateWorldTransform();
        const cardBox = card.getComponent(UITransform)!.getBoundingBoxToWorld();
        const actualCardH = this.safeNum(cardBox.height, cardH);
        const cardLocalBottomY = this.safeNum(-actualCardH / 2, -466);
        const backBtnY = this.safeNum(cardLocalBottomY + backBottomMargin + backH / 2, -398);
        backBtn.setPosition(0, backBtnY, 0);

        // ── 装扮入口按钮：在返回按钮正上方，间距 16 ──
        const dressupEntryBtn = this.createRoundButton(card, 'DressupEntryBtn', '👗  装扮',
            this.COLOR_BTN_AD, 440, dressupH, () => this.showDressupPanel());
        const dressupBtnY = this.safeNum(backBtnY + backH / 2 + btnGap + dressupH / 2, -330);
        dressupEntryBtn.setPosition(0, dressupBtnY, 0);

        this.collectionPanel.active = false;
    }

    /** Create a single collection cell */
    private createCollectionCell(parent: Node, monId: number, size: number): void {
        const node = new Node(`Cell${monId}`);
        node.parent = parent;
        const ut = node.addComponent(UITransform);
        ut.setContentSize(size, size);

        // Background
        const bgNode = new Node('Bg');
        bgNode.parent = node;
        bgNode.addComponent(UITransform).setContentSize(size, size);
        const bg = bgNode.addComponent(Graphics);
        bg.fillColor = new Color(0xF0, 0xF0, 0xF0, 180);
        bg.roundRect(-size / 2, -size / 2, size, size, 16);
        bg.fill();

        // Emoji label
        const emojiNode = new Node('Emoji');
        emojiNode.parent = node;
        emojiNode.addComponent(UITransform).setContentSize(size, size);
        const emojiLabel = emojiNode.addComponent(Label);
        emojiLabel.string = '?';
        emojiLabel.fontSize = 48;
        emojiLabel.lineHeight = 52;
        emojiLabel.color = this.COLOR_COLLECTION_SILHOUETTE.clone();
        emojiLabel.useSystemFont = true;
        emojiLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        emojiLabel.verticalAlign = Label.VerticalAlign.CENTER;
        emojiLabel.overflow = Label.Overflow.NONE;
        emojiNode.setPosition(0, 8, 0);

        // Star label
        const starNode = new Node('Star');
        starNode.parent = node;
        starNode.addComponent(UITransform).setContentSize(size, 24);
        const starLabel = starNode.addComponent(Label);
        starLabel.string = '';
        starLabel.fontSize = 16;
        starLabel.lineHeight = 20;
        starLabel.color = this.COLOR_CHAPTER_GOLD.clone();
        starLabel.useSystemFont = true;
        starLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        starLabel.verticalAlign = Label.VerticalAlign.CENTER;
        starLabel.overflow = Label.Overflow.NONE;
        starNode.setPosition(0, -28, 0);

        // Count label
        const countNode = new Node('Count');
        countNode.parent = node;
        countNode.addComponent(UITransform).setContentSize(size, 22);
        const countLabel = countNode.addComponent(Label);
        countLabel.string = '';
        countLabel.fontSize = 14;
        countLabel.lineHeight = 18;
        countLabel.color = this.COLOR_TEXT_MAIN.clone();
        countLabel.useSystemFont = true;
        countLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        countLabel.verticalAlign = Label.VerticalAlign.CENTER;
        countLabel.overflow = Label.Overflow.NONE;
        countNode.setPosition(0, -48, 0);

        // 升星按钮（E4：count>=3 且 star<5 时显示）
        const upgradeBtn = this.createRoundButton(node, 'UpgradeBtn', '升星(3合1)',
            this.COLOR_BTN_PRIMARY, size - 16, 28, () => this.onUpgradeStar(monId));
        const upgradeBtnUT = upgradeBtn.getComponent(UITransform)!;
        upgradeBtn.setPosition(0, -size / 2 + 18, 0);
        upgradeBtn.active = false;

        // 满星标签（star=5 时显示）
        const maxStarNode = new Node('MaxStar');
        maxStarNode.parent = node;
        maxStarNode.addComponent(UITransform).setContentSize(size, 22);
        const maxStarLabel = maxStarNode.addComponent(Label);
        maxStarLabel.string = '满星';
        maxStarLabel.fontSize = 14;
        maxStarLabel.lineHeight = 18;
        maxStarLabel.color = this.COLOR_CHAPTER_GOLD.clone();
        maxStarLabel.useSystemFont = true;
        maxStarLabel.isBold = true;
        maxStarLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        maxStarLabel.verticalAlign = Label.VerticalAlign.CENTER;
        maxStarLabel.overflow = Label.Overflow.NONE;
        maxStarNode.setPosition(0, -size / 2 + 18, 0);
        maxStarNode.active = false;

        this.collectionCells[monId] = { emojiLabel, starLabel, countLabel, bgNode, upgradeBtn };

        // ★ J1: 点击格子弹详情卡
        const detailBtn = node.addComponent(Button);
        detailBtn.transition = Button.Transition.NONE;
        detailBtn.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            this.showMonsterDetail(monId);
        }, this);
    }

    /** Refresh collection panel from SaveManager */
    private refreshCollectionPanel(): void {
        let ownedCount = 0;

        for (let i = 0; i < 6; i++) {
            const cell = this.collectionCells[i];
            if (!cell) continue;

            const rec = SaveManager.inst.getMonster(i);
            const count = this.safeNum(rec.count, 0);
            const star = this.safeNum(rec.star, 0);
            const isOwned = count > 0;

            if (isOwned) ownedCount++;

            // Emoji
            if (isOwned) {
                cell.emojiLabel.string = COLOR_EMOJI_MAP[i] ?? '?';
                cell.emojiLabel.color = Color.WHITE.clone();
            } else {
                cell.emojiLabel.string = '?';
                cell.emojiLabel.color = this.COLOR_COLLECTION_SILHOUETTE.clone();
            }

            // Star
            if (isOwned && star > 0) {
                cell.starLabel.string = '⭐'.repeat(Math.min(star, 5));
            } else {
                cell.starLabel.string = '';
            }

            // Count
            if (isOwned) {
                cell.countLabel.string = `×${count}`;
            } else {
                cell.countLabel.string = '';
            }

            // 升星按钮 / 满星标签（E4）
            const maxStarNode = cell.bgNode.parent?.getChildByName('MaxStar');
            const canUpgrade = isOwned && count >= 3 && star < 5;
            const isMaxStar = isOwned && star >= 5;

            cell.upgradeBtn.active = canUpgrade;
            cell.upgradeBtn.getComponent(Button)!.interactable = canUpgrade;

            if (maxStarNode) {
                maxStarNode.active = isMaxStar;
            }
        }

        // Completion
        if (this.collectionCompletionLabel) {
            this.collectionCompletionLabel.string = `已收集: ${ownedCount} / 6`;
        }

        console.log(`[Collection] 图鉴刷新: ${ownedCount}/6`);
    }

    /** E4: 升星按钮点击 → upgradeStar → 刷新 + 动画 */
    private onUpgradeStar(monId: number): void {
        const success = SaveManager.inst.upgradeStar(monId);
        if (!success) {
            console.log(`[Collection] 升星失败: monId=${monId} (条件不足)`);
            return;
        }

        // 刷新该格显示
        this.refreshCollectionPanel();

        // 升星动画：格子缩放弹跳
        const cell = this.collectionCells[monId];
        if (cell) {
            const targetNode = cell.bgNode.parent!;
            Tween.stopAllByTarget(targetNode);
            targetNode.setScale(1, 1, 1);
            tween(targetNode)
                .to(0.15, { scale: new Vec3(1.3, 1.3, 1) }, { easing: 'backOut' })
                .to(0.1, { scale: new Vec3(1, 1, 1) })
                .start();
        }

        // ★ H3: 升星上扬小音阶（复用 combo3→combo5，无文件静默）+ 震动
        try {
            AudioManager.inst?.playCombo(3);
            this.scheduleOnce(() => { try { AudioManager.inst?.playCombo(5); } catch (_) { /* ignore */ } }, 0.12);
        } catch (e) { /* ignore */ }
        VibrateManager.inst?.long();

        const rec = SaveManager.inst.getMonster(monId);
        console.log(`[Collection] 升星成功: monId=${monId} → star=${rec.star} count=${rec.count}`);
    }

    /** Show collection panel */
    private showCollectionPanel(): void {
        if (!this.collectionPanel) return;
        this.refreshCollectionPanel();
        this.showPanel(this.collectionPanel);
        this.gameClubEntry?.hide();
    }

    /** Collection back button */
    private onCollectionBack(): void {
        this.hidePanel(this.collectionPanel);
        this.showLevelSelectPanel();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  J1: 公仔详情弹卡
    // ══════════════════════════════════════════════════════════════════════════

    /** J1: 显示公仔详情卡（已拥有→详情，未拥有→占位不剧透） */
    private showMonsterDetail(monId: number): void {
        // 防护：monId 经 safeNum + 范围 0-5
        const id = (typeof monId === 'number' && isFinite(monId) && monId >= 0 && monId <= 5) ? Math.floor(monId) : 0;

        // 先清理旧的
        this.hideMonsterDetail();

        if (!this.collectionPanel) return;

        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);

        // 详情卡根节点（在图鉴面板内、卡片之上）
        const detailRoot = new Node('MonsterDetail');
        detailRoot.parent = this.collectionPanel;
        detailRoot.addComponent(UITransform).setContentSize(pw, ph);
        this.monsterDetailCard = detailRoot;

        // Mask 遮罩
        const maskNode = new Node('DetailMask');
        maskNode.parent = detailRoot;
        maskNode.addComponent(UITransform).setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 140);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        const maskOp = maskNode.addComponent(UIOpacity);

        // Card 奶白圆角
        const cardW = 420, cardH = 480;
        const card = new Node('DetailCard');
        card.parent = detailRoot;
        card.addComponent(UITransform).setContentSize(cardW, cardH);
        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 24);
        cardG.fill();
        cardG.stroke();
        const cardOp = card.addComponent(UIOpacity);

        // Layout 竖排
        const cardLayout = card.addComponent(Layout);
        cardLayout.type = Layout.Type.VERTICAL;
        cardLayout.spacingY = 16;
        cardLayout.paddingTop = 36;
        cardLayout.paddingBottom = 36;
        cardLayout.horizontalDirection = Layout.HorizontalDirection.CENTER;
        cardLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
        cardLayout.resizeMode = Layout.ResizeMode.NONE;

        const rec = SaveManager.inst.getMonster(id);
        const isOwned = rec.count > 0;

        if (isOwned) {
            // 已拥有：大 emoji + 名字 + 稀有度 + 性格 + 星级 + 数量
            const emoji = COLOR_EMOJI_MAP[id] ?? '?';
            const name = MON_NAME[id] ?? '???';
            const desc = MON_DESC[id] ?? '';
            const rarity = MON_RARITY[id] ?? 'R';
            const star = this.safeNum(rec.star, 0);
            const count = this.safeNum(rec.count, 0);

            // 大 emoji
            const emojiLabel = this.createLabel(card, 'Emoji', emoji, 72, this.COLOR_TEXT_MAIN);
            emojiLabel.node.getComponent(UITransform)!.setContentSize(cardW - 40, 90);

            // 名字 + 稀有度
            let rarityColor: Color;
            switch (rarity) {
                case 'SSR': rarityColor = this.COLOR_RARITY_SSR.clone(); break;
                case 'SR': rarityColor = this.COLOR_RARITY_SR.clone(); break;
                default: rarityColor = this.COLOR_RARITY_R.clone(); break;
            }
            const nameLabel = this.createLabel(card, 'Name', `${name}  [${rarity}]`, 32, rarityColor);
            nameLabel.isBold = true;
            nameLabel.node.getComponent(UITransform)!.setContentSize(cardW - 40, 44);

            // 性格文案
            const descLabel = this.createLabel(card, 'Desc', desc, 24, this.COLOR_TEXT_MAIN);
            descLabel.node.getComponent(UITransform)!.setContentSize(cardW - 60, 36);

            // 星级 + 数量
            const infoLabel = this.createLabel(card, 'Info', `⭐${star}  ×${count}`, 26, this.COLOR_CHAPTER_GOLD);
            infoLabel.isBold = true;
            infoLabel.node.getComponent(UITransform)!.setContentSize(cardW - 40, 36);
        } else {
            // 未拥有：不剧透
            const emojiLabel = this.createLabel(card, 'Emoji', '？？？', 64, this.COLOR_COLLECTION_SILHOUETTE);
            emojiLabel.node.getComponent(UITransform)!.setContentSize(cardW - 40, 90);

            const nameLabel = this.createLabel(card, 'Name', '还没遇到 ta', 30, this.COLOR_COLLECTION_SILHOUETTE);
            nameLabel.isBold = true;
            nameLabel.node.getComponent(UITransform)!.setContentSize(cardW - 40, 44);

            const descLabel = this.createLabel(card, 'Desc', '继续冒险去发现吧~', 22, this.COLOR_LEVEL_LOCKED_TEXT);
            descLabel.node.getComponent(UITransform)!.setContentSize(cardW - 60, 32);
        }

        // 关闭按钮
        this.createRoundButton(card, 'CloseBtn', '关闭',
            this.COLOR_BTN_GIVEUP, 200, 56, () => this.hideMonsterDetail(),
            { ghost: true });

        // 弹入动画
        card.setScale(0, 0, 1);
        Tween.stopAllByTarget(card);
        tween(card)
            .to(0.25, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'backOut' })
            .to(0.1, { scale: new Vec3(1, 1, 1) })
            .start();

        maskOp.opacity = 0;
        tween(maskOp).to(0.2, { opacity: 255 }).start();

        // 点击遮罩关闭
        const maskBtn = maskNode.addComponent(Button);
        maskBtn.transition = Button.Transition.NONE;
        maskBtn.node.on(Button.EventType.CLICK, () => this.hideMonsterDetail(), this);
    }

    /** J1: 隐藏公仔详情卡 */
    private hideMonsterDetail(): void {
        if (!this.monsterDetailCard) return;
        const card = this.monsterDetailCard.getChildByName('DetailCard');
        const mask = this.monsterDetailCard.getChildByName('DetailMask');
        const root = this.monsterDetailCard;
        this.monsterDetailCard = null;

        // 淡出 → 销毁
        if (card) {
            const op = card.getComponent(UIOpacity);
            if (op) {
                Tween.stopAllByTarget(op);
                tween(op).to(0.15, { opacity: 0 }).start();
            }
        }
        if (mask) {
            const op = mask.getComponent(UIOpacity);
            if (op) {
                Tween.stopAllByTarget(op);
                tween(op).to(0.15, { opacity: 0 })
                    .call(() => { if (root.isValid) root.destroy(); })
                    .start();
            } else {
                if (root.isValid) root.destroy();
            }
        } else {
            if (root.isValid) root.destroy();
        }
    }

    /** 点击关卡按钮 → 进关（D3 接线） */
    private onLevelButtonClick(levelIdx: number): void {
        // 越界保护
        if (levelIdx < 0 || levelIdx >= this.levelConfigs.length) {
            console.warn(`[GameManager] 关卡索引越界: ${levelIdx}，回退到 0`);
            levelIdx = 0;
        }
        const config = this.levelConfigs[levelIdx];
        console.log(`[GameManager] 选择关卡 L${config.level} (第${config.chapter}章${config.isBoss ? '·Boss' : ''})`);
        this.hidePanel(this.levelSelectPanel);
        this.startLevel(levelIdx);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  UI 工具方法
    // ══════════════════════════════════════════════════════════════════════════

    private addWidget(node: Node, opts: WidgetOptions): Widget {
        const widget = node.addComponent(Widget);
        widget.alignMode = Widget.AlignMode.ALWAYS;

        if (opts.top !== undefined) {
            widget.isAlignTop = true;
            widget.top = this.safeNum(opts.top, 0);
        }
        if (opts.bottom !== undefined) {
            widget.isAlignBottom = true;
            widget.bottom = this.safeNum(opts.bottom, 0);
        }
        if (opts.left !== undefined) {
            widget.isAlignLeft = true;
            widget.left = this.safeNum(opts.left, 0);
        }
        if (opts.right !== undefined) {
            widget.isAlignRight = true;
            widget.right = this.safeNum(opts.right, 0);
        }
        if (opts.hCenter !== undefined) {
            widget.isAlignHorizontalCenter = true;
            widget.horizontalCenter = this.safeNum(opts.hCenter, 0);
        }
        if (opts.vCenter !== undefined) {
            widget.isAlignVerticalCenter = true;
            widget.verticalCenter = this.safeNum(opts.vCenter, 0);
        }

        widget.updateAlignment();
        return widget;
    }

    private createLabel(parent: Node, name: string, text: string, fontSize: number, color: Color): Label {
        const node = new Node(name);
        node.parent = parent;

        const ut = node.addComponent(UITransform);
        ut.setContentSize(260, fontSize + 10);

        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 4;
        label.color = color.clone();
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.NONE;

        return label;
    }

    private createPanelContent(parent: Node, w: number, h: number, color: Color): Node {
        // 保留兼容（已不再使用，但以防外部引用）
        const node = new Node('Content');
        node.parent = parent;
        const ut = node.addComponent(UITransform);
        ut.setContentSize(w, h);
        return node;
    }

    /** Graphics 圆角按钮（半径 40）+ Button(SCALE 反馈)，支持幽灵模式 */
    private createRoundButton(parent: Node, name: string, text: string,
        bgColor: Color, w: number, h: number, callback: () => void,
        options?: { ghost?: boolean; strokeColor?: Color; textColor?: Color; strokeWidth?: number },
    ): Node {
        const ghost = options?.ghost ?? false;
        const strokeColor = options?.strokeColor ?? (ghost ? this.COLOR_GHOST_BORDER : this.COLOR_BTN_STROKE);
        const textColor = options?.textColor ?? (ghost ? this.COLOR_GHOST_TEXT : Color.WHITE);
        const strokeWidth = this.safeNum(options?.strokeWidth ?? (ghost ? 3 : 2), 2);

        const node = new Node(name);
        node.parent = parent;

        const ut = node.addComponent(UITransform);
        ut.setContentSize(w, h);

        // Graphics 画圆角底 + 描边
        const g = node.addComponent(Graphics);
        g.fillColor = ghost ? new Color(255, 255, 255, 10) : bgColor.clone();
        g.strokeColor = strokeColor.clone();
        g.lineWidth = strokeWidth;
        g.roundRect(-w / 2, -h / 2, w, h, 40);
        g.fill();
        g.stroke();

        // Label
        const labelNode = new Node('Label');
        labelNode.parent = node;
        const labelUT = labelNode.addComponent(UITransform);
        labelUT.setContentSize(w, h);
        const label = labelNode.addComponent(Label);
        label.string = text;
        label.fontSize = 36;
        label.lineHeight = 40;
        label.color = textColor.clone();
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;

        // ★ P1: Button.Transition.NONE（手动 tween 统一控制缩放，避免双控抢改 scale）
        const button = node.addComponent(Button);
        button.transition = Button.Transition.NONE;

        // ★ H3: 按钮点击音 + 按下 scale 0.95 微缩反馈
        button.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            // 微缩反馈（0.08s 回弹，不影响点击命中区）
            Tween.stopAllByTarget(node);
            node.setScale(0.95, 0.95, 1);
            tween(node)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);

        button.node.on(Button.EventType.CLICK, callback, this);

        return node;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  W · 局内道具栏
    // ══════════════════════════════════════════════════════════════════════════

    /** W: 创建道具栏（三按钮横排） */
    private createBoosterBar(): void {
        const canvas = this.node.parent!;
        const bar = new Node('BoosterBar');
        bar.parent = canvas;
        const barUT = bar.addComponent(UITransform);
        barUT.setContentSize(540, 56);
        bar.setPosition(0, -560, 0);
        bar.active = false;
        this.boosterBar = bar;

        // 三个按钮
        this.hammerBtn = this.createBoosterButton(bar, 'HammerBtn', '🔨 ×1', 0, () => this.onHammerBoosterClick());
        this.shuffleBtn = this.createBoosterButton(bar, 'ShuffleBtn', '🔀 ×1', -185, () => this.onShuffleBoosterClick());
        this.addStepsBtn = this.createBoosterButton(bar, 'AddStepsBtn', '👣+3 ×1', 185, () => this.onAddStepsBoosterClick());

        // 缓存 Label
        this.hammerLabel = this.hammerBtn.getChildByName('Label')?.getComponent(Label) ?? null;
        this.shuffleLabel = this.shuffleBtn.getChildByName('Label')?.getComponent(Label) ?? null;
        this.addStepsLabel = this.addStepsBtn.getChildByName('Label')?.getComponent(Label) ?? null;
    }

    /** W: 创建单个道具按钮（比 createRoundButton 更紧凑） */
    private createBoosterButton(parent: Node, name: string, text: string, offsetX: number, callback: () => void): Node {
        const w = 165;
        const h = 50;
        const node = new Node(name);
        node.parent = parent;
        const ut = node.addComponent(UITransform);
        ut.setContentSize(w, h);
        node.setPosition(offsetX, 0, 0);

        // Graphics 画圆角底 + 描边
        const g = node.addComponent(Graphics);
        g.fillColor = new Color(255, 255, 255, 220);
        g.strokeColor = new Color(0x9B, 0x59, 0xD9, 255);  // 紫色描边
        g.lineWidth = 2;
        g.roundRect(-w / 2, -h / 2, w, h, 24);
        g.fill();
        g.stroke();

        // Label
        const labelNode = new Node('Label');
        labelNode.parent = node;
        const labelUT = labelNode.addComponent(UITransform);
        labelUT.setContentSize(w, h);
        const label = labelNode.addComponent(Label);
        label.string = text;
        label.fontSize = 22;
        label.lineHeight = 26;
        label.color = new Color(0x6A, 0x3D, 0xA8, 255);  // 紫色文字
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;

        // Button（手动 tween 缩放反馈）
        const button = node.addComponent(Button);
        button.transition = Button.Transition.NONE;
        button.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(node);
            node.setScale(0.95, 0.95, 1);
            tween(node)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        button.node.on(Button.EventType.CLICK, callback, this);

        return node;
    }

    /** W: 刷新道具栏 UI（次数、按钮状态、高亮） */
    private updateBoosterUI(): void {
        if (!this.boosterBar) return;

        const setBtn = (btn: Node | null, label: Label | null, count: number, baseText: string, highlight: boolean) => {
            if (!btn) return;
            const btnComp = btn.getComponent(Button);
            const g = btn.getComponent(Graphics);
            if (!btnComp || !g) return;

            const used = count <= 0;
            btnComp.interactable = !used && !this.boosterBusy;

            // 重绘底色
            const w = 165, h = 50;
            g.clear();
            if (used) {
                g.fillColor = new Color(200, 200, 200, 100);
                g.strokeColor = new Color(150, 150, 150, 120);
            } else if (highlight) {
                g.fillColor = new Color(0xFF, 0xF0, 0xA0, 240);  // 高亮黄底
                g.strokeColor = new Color(0xE8, 0x8B, 0x1A, 255); // 橙色描边
            } else {
                g.fillColor = new Color(255, 255, 255, 220);
                g.strokeColor = new Color(0x9B, 0x59, 0xD9, 255);
            }
            g.lineWidth = highlight ? 3 : 2;
            g.roundRect(-w / 2, -h / 2, w, h, 24);
            g.fill();
            g.stroke();

            // 更新文字
            if (label) {
                if (highlight) {
                    label.string = '🔨 选目标';
                } else {
                    label.string = baseText + ` ×${count}`;
                }
                label.color = used
                    ? new Color(150, 150, 150, 150)
                    : (highlight ? new Color(0xC0, 0x60, 0x00, 255) : new Color(0x6A, 0x3D, 0xA8, 255));
            }
        };

        setBtn(this.hammerBtn, this.hammerLabel, this.hammerCount, '🔨', this.hammerSelecting);
        setBtn(this.shuffleBtn, this.shuffleLabel, this.shuffleCount, '🔀', false);
        setBtn(this.addStepsBtn, this.addStepsLabel, this.addStepsCount, '👣+3', false);
    }

    // ── W: 道具栏位置（在 layoutBoard 后调用） ──────
    private layoutBoosterBar(): void {
        if (!this.boosterBar) return;
        const boardNode = this.node.parent?.getChildByName('Board');
        if (!boardNode) return;

        // 棋盘底边的世界坐标 → Canvas 局部坐标
        const { ROWS, TILE_SIZE, GAP } = Board;
        const halfBoard = (ROWS * TILE_SIZE + (ROWS - 1) * GAP) / 2;
        const boardBottomLocal = boardNode.position.y - halfBoard;

        // 道具栏放在棋盘下方 45~55px
        const barY = boardBottomLocal - 50;

        // 确保不超出底部安全区
        const canvasH = this.safeNum(this.canvasH, 1280);
        const minBottom = -(canvasH / 2) + 50;
        const finalY = Math.max(barY, minBottom);

        this.boosterBar.setPosition(0, finalY, 0);
    }

    // ── W: 道具栏可见性 ──────────────────────────
    private updateBoosterBarVisible(): void {
        if (!this.boosterBar) return;
        const anyPanelOpen =
            (this.resultPanel?.active ?? false) ||
            (this.stepsPanel?.active ?? false) ||
            (this.pausePanel?.active ?? false) ||
            (this.levelSelectPanel?.active ?? false) ||
            (this.gachaPanel?.active ?? false) ||
            (this.collectionPanel?.active ?? false) ||
            (this.homePanel?.active ?? false) ||
            (this.chapterCard?.active ?? false) ||
            (this.settingsPanel?.active ?? false) ||
            (this.dressupPanel?.active ?? false) ||
            (this.dailySignPanel?.active ?? false);
        this.boosterBar.active = this._inLevel && !anyPanelOpen;
    }

    // ── W: 锤子提示文字 ──────────────────────────
    private showHammerHint(): void {
        if (this.hammerHintLabel) return;  // 已存在
        const canvas = this.node.parent!;
        const node = new Node('HammerHint');
        node.parent = canvas;
        const ut = node.addComponent(UITransform);
        ut.setContentSize(500, 36);
        // 放在棋盘上方
        const boardNode = canvas.getChildByName('Board');
        const { ROWS, TILE_SIZE, GAP } = Board;
        const halfBoard = (ROWS * TILE_SIZE + (ROWS - 1) * GAP) / 2;
        const hintY = boardNode ? boardNode.position.y + halfBoard + 30 : 200;
        node.setPosition(0, hintY, 0);

        const label = node.addComponent(Label);
        label.string = '🔨 点击一个萌宠、冰层或木箱';
        label.fontSize = 24;
        label.lineHeight = 28;
        label.color = new Color(0x6A, 0x3D, 0xA8, 255);
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;

        // 淡入
        const op = node.addComponent(UIOpacity);
        op.opacity = 0;
        tween(op).to(0.2, { opacity: 255 }).start();

        this.hammerHintLabel = label;
    }

    private hideHammerHint(): void {
        if (!this.hammerHintLabel) return;
        const node = this.hammerHintLabel.node;
        if (node && node.isValid) {
            node.destroy();
        }
        this.hammerHintLabel = null;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  W · 道具按钮点击处理
    // ══════════════════════════════════════════════════════════════════════════

    /** W: 小锤子按钮 */
    private onHammerBoosterClick(): void {
        if (this.hammerCount <= 0) return;
        if (this.boosterBusy) return;

        // 如果正在选目标，再次点击 = 取消
        if (this.hammerSelecting) {
            this.board?.cancelHammerMode();
            this.hammerSelecting = false;
            this.hideHammerHint();
            this.updateBoosterUI();
            return;
        }

        // 进入锤子选择模式
        const ok = this.board?.beginHammerMode() ?? false;
        if (ok) {
            this.hammerSelecting = true;
            this.showHammerHint();
            this.updateBoosterUI();
        }
    }

    /** W: 重新洗牌按钮 */
    private async onShuffleBoosterClick(): Promise<void> {
        if (this.shuffleCount <= 0) return;
        if (this.boosterBusy) return;
        if (this.hammerSelecting) return;

        this.boosterBusy = true;
        this.updateBoosterUI();

        try {
            const ok = await this.board?.useShuffleBooster();
            if (ok) {
                this.shuffleCount = Math.max(0, this.shuffleCount - 1);
                this.shuffleUsedThisRun = true;
            }
        } catch (e) {
            console.error('[GameManager] 洗牌道具异常:', e);
        } finally {
            this.boosterBusy = false;
            this.updateBoosterUI();
        }
    }

    /** W: +3 步按钮 */
    private onAddStepsBoosterClick(): void {
        if (this.addStepsCount <= 0) return;
        if (this.boosterBusy) return;
        if (this.hammerSelecting) return;
        if (!this._inLevel) return;
        // 弹层打开时不可用
        if (this.resultPanel?.active || this.stepsPanel?.active || this.pausePanel?.active) return;

        this.currentSteps += 3;
        this.addStepsCount = Math.max(0, this.addStepsCount - 1);
        this.addStepsUsedThisRun = true;
        this.updateHUD();
        this.updateBoosterUI();

        // 简单 scale 弹动步数 Label
        if (this.stepsLabel) {
            Tween.stopAllByTarget(this.stepsLabel.node);
            this.stepsLabel.node.setScale(1.3, 1.3, 1);
            tween(this.stepsLabel.node)
                .to(0.2, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }
    }

    /** W: Board 锤子解析完成回调 */
    private onHammerResolved(success: boolean): void {
        if (success) {
            this.hammerCount = Math.max(0, this.hammerCount - 1);
            this.hammerSelecting = false;
            this.boosterBusy = false;
            this.hammerUsedThisRun = true;
            this.hideHammerHint();
            this.updateBoosterUI();
            // 统一目标判定
            this.evaluateLevelAfterBoardStable();
        } else {
            // 失败 — 不扣次数
            this.hammerSelecting = false;
            this.boosterBusy = false;
            this.hideHammerHint();
            this.updateBoosterUI();
        }
    }
    // ══════════════════════════════════════════════════════════════════════════

    /** 点暂停键 → 弹出暂停卡，锁棋盘 */
    private onPauseClick(): void {
        if (!this.pausePanel) return;
        // 确保主卡显示、确认卡隐藏
        if (this.pauseCard) {
            this.pauseCard.active = true;
            this.pauseCard.setScale(1, 1, 1);
        }
        if (this.pauseConfirmCard) {
            this.pauseConfirmCard.active = false;
            this.pauseConfirmCard.setScale(1, 1, 1);
        }
        // 锁棋盘输入
        this.board?.setBusy(true);
        // 弹出暂停面板（showPanel 会调 updatePauseBtnVisible 隐藏暂停键）
        this.showPanel(this.pausePanel);
        console.log('[GameManager] 暂停');
    }

    /** 继续 → 关闭暂停弹层，恢复游戏 */
    private onPauseContinue(): void {
        this.hidePanel(this.pausePanel);
        // 解锁棋盘
        this.board?.setBusy(false);
        // hidePanel 延迟回调会调 updatePauseBtnVisible 恢复暂停键
        console.log('[GameManager] 继续游戏');
    }

    /** 重玩本关 → 弹出二次确认 */
    private onPauseRestartClick(): void {
        // 主卡淡出
        if (this.pauseCard) {
            Tween.stopAllByTarget(this.pauseCard);
            tween(this.pauseCard)
                .to(0.15, { scale: new Vec3(0.85, 0.85, 1) })
                .call(() => { if (this.pauseCard) this.pauseCard.active = false; })
                .start();
        }
        // 确认卡弹入
        if (this.pauseConfirmCard) {
            this.pauseConfirmCard.active = true;
            this.pauseConfirmCard.setScale(0, 0, 1);
            Tween.stopAllByTarget(this.pauseConfirmCard);
            tween(this.pauseConfirmCard)
                .to(0.25, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'backOut' })
                .to(0.1, { scale: new Vec3(1, 1, 1) })
                .start();
        }
        console.log('[GameManager] 暂停 → 重玩确认');
    }

    /** 取消重玩 → 回到暂停主卡 */
    private onPauseRestartCancel(): void {
        // 确认卡淡出
        if (this.pauseConfirmCard) {
            Tween.stopAllByTarget(this.pauseConfirmCard);
            tween(this.pauseConfirmCard)
                .to(0.15, { scale: new Vec3(0.85, 0.85, 1) })
                .call(() => { if (this.pauseConfirmCard) this.pauseConfirmCard.active = false; })
                .start();
        }
        // 主卡弹回
        if (this.pauseCard) {
            this.pauseCard.active = true;
            this.pauseCard.setScale(0, 0, 1);
            Tween.stopAllByTarget(this.pauseCard);
            tween(this.pauseCard)
                .to(0.25, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'backOut' })
                .to(0.1, { scale: new Vec3(1, 1, 1) })
                .start();
        }
        console.log('[GameManager] 取消重玩');
    }

    /** 确认重玩 → 关闭暂停弹层，重开本关 */
    private onPauseRestartConfirm(): void {
        this.hidePanel(this.pausePanel);
        // startLevel 会重置一切（不触发过关写盘/发币）
        this.startLevel(this.currentLevel);
        console.log('[GameManager] 确认重玩本关');
    }

    /** 返回关卡选择 → 不写通关/不发币/不改存档 */
    private onPauseLevelSelect(): void {
        this.hidePanel(this.pausePanel);
        this._inLevel = false;
        this.showLevelSelectPanel();
        console.log('[GameManager] 暂停 → 返回关卡选择（不记通关/不发币）');
    }

    /** 暂停键可见性：仅在关卡中且无弹层时显示 */
    private updatePauseBtnVisible(): void {
        if (!this.pauseBtn) return;
        const anyPanelOpen =
            (this.resultPanel?.active ?? false) ||
            (this.stepsPanel?.active ?? false) ||
            (this.pausePanel?.active ?? false) ||
            (this.levelSelectPanel?.active ?? false) ||
            (this.gachaPanel?.active ?? false) ||
            (this.collectionPanel?.active ?? false) ||
            (this.homePanel?.active ?? false) ||
            (this.chapterCard?.active ?? false) ||
            (this.settingsPanel?.active ?? false) ||
            (this.dressupPanel?.active ?? false) ||
            (this.dailySignPanel?.active ?? false);
        this.pauseBtn.active = this._inLevel && !anyPanelOpen;

        // W: 同步道具栏可见性
        if (anyPanelOpen && this.hammerSelecting) {
            // 弹层打开时安全取消锤子选择
            this.board?.cancelHammerMode();
            this.hammerSelecting = false;
            this.hideHammerHint();
        }
        this.updateBoosterBarVisible();
        this.updateBoosterUI();
    }

    private showPanel(panel: Node | null, silent: boolean = false): void {
        if (!panel) return;

        // 取消待隐藏
        this.hidingPanels.delete(panel);

        // 置于最上层（高于任何棋盘遮罩）
        const parent = panel.parent;
        if (parent) {
            const lastIdx = parent.children.length - 1;
            if (panel.getSiblingIndex() !== lastIdx) {
                panel.setSiblingIndex(lastIdx);
            }
        }

        // 面板根节点挂 BlockInputEvents（最顶层触摸拦截，不拦按钮——按钮在面板内、siblingIndex 更高）
        let blockInput = panel.getComponent(BlockInputEvents);
        if (!blockInput) {
            blockInput = panel.addComponent(BlockInputEvents);
        }

        panel.active = true;

        // 遮罩淡入
        const mask = panel.getChildByName('Mask');
        if (mask) {
            const op = mask.getComponent(UIOpacity);
            if (op) {
                Tween.stopAllByTarget(op);
                op.opacity = 0;
                tween(op).to(0.3, { opacity: 255 }).start();
            }
        }

        // 阴影淡入（略微延迟，跟卡片一起出现）
        const shadow = panel.getChildByName('CardShadow');
        if (shadow) {
            const op = shadow.getComponent(UIOpacity);
            if (op) {
                Tween.stopAllByTarget(op);
                op.opacity = 0;
                tween(op).delay(0.05).to(0.25, { opacity: 255 }).start();
            }
        }

        // 卡片弹出 backOut 0→1.05→1 (~0.4s)
        const card = panel.getChildByName('Card');
        if (card) {
            Tween.stopAllByTarget(card);
            card.setScale(0, 0, 1);
            tween(card)
                .to(0.28, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'backOut' })
                .to(0.12, { scale: new Vec3(1, 1, 1) })
                .start();
        }

        // ★ P2: 页面开合音 — silent 时跳过（结算/失败已播 playWin/playLose）
        if (!silent) {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
        }

        // 暂停键可见性更新（任何弹层打开时隐藏）
        this.updatePauseBtnVisible();
    }

    private hidePanel(panel: Node | null): void {
        if (!panel || !panel.active) return;

        this.hidingPanels.add(panel);

        const mask = panel.getChildByName('Mask');
        const card = panel.getChildByName('Card');
        const shadow = panel.getChildByName('CardShadow');

        // 卡片缩小
        if (card) {
            Tween.stopAllByTarget(card);
            tween(card).to(0.15, { scale: new Vec3(0.85, 0.85, 1) }).start();
        }

        // 遮罩淡出
        if (mask) {
            const op = mask.getComponent(UIOpacity);
            if (op) {
                Tween.stopAllByTarget(op);
                tween(op).to(0.15, { opacity: 0 }).start();
            }
        }

        // 阴影淡出
        if (shadow) {
            const op = shadow.getComponent(UIOpacity);
            if (op) {
                Tween.stopAllByTarget(op);
                tween(op).to(0.15, { opacity: 0 }).start();
            }
        }

        // 延迟隐藏（等动画结束）
        this.scheduleOnce(() => {
            if (!this.hidingPanels.has(panel)) return;
            this.hidingPanels.delete(panel);
            panel.active = false;
            // 关闭面板根的输入拦截
            const blockInput = panel.getComponent(BlockInputEvents);
            if (blockInput) blockInput.enabled = false;
            // 重置供下次显示
            if (mask) {
                const op = mask.getComponent(UIOpacity);
                if (op) op.opacity = 255;
            }
            if (shadow) {
                const op = shadow.getComponent(UIOpacity);
                if (op) op.opacity = 255;
            }
            if (card) {
                card.setScale(1, 1, 1);
            }
            // 暂停键可见性更新（弹层关闭后恢复）
            this.updatePauseBtnVisible();
        }, 0.17);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  章节过场卡
    // ══════════════════════════════════════════════════════════════════════════

    private createChapterCard(): void {
        this.chapterCard = new Node('ChapterCard');
        this.chapterCard.parent = this.node.parent!;
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        const panelUT = this.chapterCard.addComponent(UITransform);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.chapterCard, { top: 0, bottom: 0, left: 0, right: 0 });

        // 全屏遮罩
        const maskNode = new Node('Mask');
        maskNode.parent = this.chapterCard;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 160);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        const maskOp = maskNode.addComponent(UIOpacity);
        maskOp.opacity = 0;

        // 奶白卡片
        const cardW = 500, cardH = 360;
        const card = new Node('Card');
        card.parent = this.chapterCard;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        card.addComponent(UIOpacity);
        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        // Layout 竖排
        const cardLayout = card.addComponent(Layout);
        cardLayout.type = Layout.Type.VERTICAL;
        cardLayout.spacingY = 20;
        cardLayout.paddingTop = 50;
        cardLayout.paddingBottom = 50;
        cardLayout.horizontalDirection = Layout.HorizontalDirection.CENTER;
        cardLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
        cardLayout.resizeMode = Layout.ResizeMode.NONE;

        // 大字 "第 X 章"
        this.chapterTitleLabel = this.createLabel(card, 'ChapterTitle', '', 56, this.COLOR_TITLE_WIN);
        this.chapterTitleLabel.isBold = true;
        const titleW = this.safeNum(cardW - 80, 420);
        this.chapterTitleLabel.node.getComponent(UITransform)!.setContentSize(titleW, 80);
        this.chapterTitleLabel.overflow = Label.Overflow.SHRINK;
        this.chapterTitleLabel.enableWrapText = false;

        // 副标题
        this.chapterSubtitleLabel = this.createLabel(card, 'ChapterSubtitle', '', 36, this.COLOR_TEXT_MAIN);
        const subW = this.safeNum(cardW - 80, 420);
        this.chapterSubtitleLabel.node.getComponent(UITransform)!.setContentSize(subW, 50);
        this.chapterSubtitleLabel.overflow = Label.Overflow.SHRINK;
        this.chapterSubtitleLabel.enableWrapText = false;

        // Boss 标识（默认隐藏）
        this.chapterBossLabel = this.createLabel(card, 'BossBadge', '', 32, this.COLOR_CHAPTER_GOLD);
        this.chapterBossLabel.isBold = true;
        const bossW = this.safeNum(cardW - 80, 420);
        this.chapterBossLabel.node.getComponent(UITransform)!.setContentSize(bossW, 44);
        this.chapterBossLabel.overflow = Label.Overflow.SHRINK;
        this.chapterBossLabel.enableWrapText = false;
        this.chapterBossLabel.node.active = false;

        this.chapterCard.active = false;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  章节主题色
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 按章节切换游戏背景色调（0.3s 淡变过渡）
     * - chapter 1: 暖粉奶油  2: 薄荷奶绿  3: 暮光薰衣草
     * - NaN/越界 → 回退第1章主题色
     * - 颜色解析失败 → 回退当前基底色，绝不黑屏
     */
    private applyChapterTheme(chapter: number): void {
        if (!this.gameBgG || !this.gameBgNode || !this.gameBgOp) return;

        // 防护：NaN/越界回退第1章
        const ch = this.isValidNum(chapter) && chapter >= 1 && chapter <= GameManager.CHAPTER_BG_THEMES.length
            ? Math.floor(chapter) : 1;
        const theme = GameManager.CHAPTER_BG_THEMES[ch - 1];

        // 解析颜色（失败回退第1章基底色，绝不黑屏）
        const fallbackTop = new Color(0xFD, 0xF2, 0xF8);
        const fallbackBot = new Color(0xF5, 0xE8, 0xF0);
        const topColor = this.parseHexColor(theme.top, fallbackTop);
        const botColor = this.parseHexColor(theme.bottom, fallbackBot);
        const midColor = new Color(
            Math.round((topColor.r + botColor.r) / 2),
            Math.round((topColor.g + botColor.g) / 2),
            Math.round((topColor.b + botColor.b) / 2),
            255,
        );

        // 0.3s 淡变过渡：淡出 0.15s → 重绘 → 淡入 0.15s
        Tween.stopAllByTarget(this.gameBgOp);
        tween(this.gameBgOp)
            .to(0.15, { opacity: 0 })
            .call(() => {
                try {
                    this.drawChapterBackground(topColor, midColor, botColor);
                } catch (e) {
                    console.warn('[GameManager] 章节背景重绘失败，保持当前背景', e);
                }
            })
            .to(0.15, { opacity: 255 })
            .start();

        console.log(`[GameManager] 章节主题色切换 → 第${ch}章 (${theme.top}→${theme.bottom})`);
    }

    /** 用 Graphics 绘制 3 段竖向渐变 + 暗角 + 柔点装饰 */
    private drawChapterBackground(top: Color, mid: Color, bot: Color): void {
        const bgG = this.gameBgG;
        if (!bgG) return;
        const bgW = this.safeNum(this.canvasW, 720);
        const bgH = this.safeNum(this.canvasH, 1280);
        const segH = bgH / 3;

        bgG.clear();

        // 3 段竖向渐变：顶 → 中 → 底
        bgG.fillColor = top;
        bgG.rect(-bgW / 2, bgH / 6, bgW, segH);
        bgG.fill();
        bgG.fillColor = mid;
        bgG.rect(-bgW / 2, -bgH / 6, bgW, segH);
        bgG.fill();
        bgG.fillColor = bot;
        bgG.rect(-bgW / 2, -bgH / 2, bgW, segH);
        bgG.fill();

        // 暗角 vignette：四边叠深色边框，把视线漏斗到棋盘
        const vCol = new Color(60, 40, 60, 40);
        bgG.fillColor = vCol.clone();
        bgG.rect(-bgW / 2, bgH / 2 - 70, bgW, 70);   // 顶部
        bgG.fill();
        bgG.rect(-bgW / 2, -bgH / 2, bgW, 70);       // 底部
        bgG.fill();
        bgG.rect(-bgW / 2, -bgH / 2, 50, bgH);       // 左侧
        bgG.fill();
        bgG.rect(bgW / 2 - 50, -bgH / 2, 50, bgH);   // 右侧
        bgG.fill();

        // 装饰柔点：大而柔、低透明度，不抢方块
        bgG.fillColor = new Color(0xD4, 0xC0, 0xD5, 30);
        bgG.ellipse(-bgW * 0.3, bgH * 0.2, 120, 120);
        bgG.fill();
        bgG.fillColor = new Color(0xE0, 0xCC, 0xE0, 25);
        bgG.ellipse(bgW * 0.25, -bgH * 0.15, 100, 100);
        bgG.fill();
    }

    /** 解析 #RRGGBB 十六进制颜色字符串，失败返回 fallback */
    private parseHexColor(hex: string, fallback: Color): Color {
        try {
            const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
            if (!m) return fallback.clone();
            const v = parseInt(m[1], 16);
            return new Color((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF, 255);
        } catch (e) {
            return fallback.clone();
        }
    }

    /** 弹出章节过场卡：backOut 弹入 → 停留 1.2s → 淡出 → 回 IDLE */
    private showChapterCard(chapter: number, isBoss: boolean): void {
        if (!this.chapterCard) return;
        this.chapterCardShowing = true;
        this.lastChapter = chapter;

        // 锁定棋盘
        this.board?.setBusy(true);

        // 填充文本
        this.chapterTitleLabel!.string = `第 ${chapter} 章`;
        this.chapterSubtitleLabel!.string = this.getChapterSubtitle(chapter);
        if (isBoss) {
            this.chapterBossLabel!.string = '⭐ 章末 BOSS';
            this.chapterBossLabel!.node.active = true;
        } else {
            this.chapterBossLabel!.node.active = false;
        }

        // 置顶
        const parent = this.chapterCard.parent;
        if (parent) {
            this.chapterCard.setSiblingIndex(parent.children.length - 1);
        }
        this.chapterCard.active = true;

        // 遮罩淡入
        const mask = this.chapterCard.getChildByName('Mask');
        const maskOp = mask?.getComponent(UIOpacity);
        if (maskOp) {
            Tween.stopAllByTarget(maskOp);
            maskOp.opacity = 0;
            tween(maskOp).to(0.2, { opacity: 255 }).start();
        }

        // 卡片 backOut 弹入
        const card = this.chapterCard.getChildByName('Card');
        const cardOp = card?.getComponent(UIOpacity);
        if (card && cardOp) {
            Tween.stopAllByTarget(card);
            Tween.stopAllByTarget(cardOp);
            card.setScale(0, 0, 1);
            cardOp.opacity = 255;
            tween(card)
                .to(0.3, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'backOut' })
                .to(0.1, { scale: new Vec3(1, 1, 1) })
                .start();
        }

        // 停留 1.2s 后淡出
        this.scheduleOnce(() => {
            this.hideChapterCard();
        }, 1.5);

        console.log(`[GameManager] 章节过场卡: 第${chapter}章 ${isBoss ? '(Boss)' : ''}`);
        this.updatePauseBtnVisible();
    }

    /** 隐藏章节过场卡 → 回 IDLE */
    private hideChapterCard(): void {
        if (!this.chapterCard || !this.chapterCard.active) return;
        this.chapterCardShowing = false;

        const mask = this.chapterCard.getChildByName('Mask');
        const card = this.chapterCard.getChildByName('Card');
        const cardOp = card?.getComponent(UIOpacity);

        // 卡片淡出
        if (card && cardOp) {
            Tween.stopAllByTarget(cardOp);
            tween(cardOp).to(0.25, { opacity: 0 }).start();
        }
        // 遮罩淡出
        if (mask) {
            const maskOp = mask.getComponent(UIOpacity);
            if (maskOp) {
                Tween.stopAllByTarget(maskOp);
                tween(maskOp).to(0.3, { opacity: 0 }).start();
            }
        }

        // 延迟隐藏 + 回 IDLE
        this.scheduleOnce(() => {
            if (this.chapterCard) this.chapterCard.active = false;
            this.board?.setBusy(false);
            this.updatePauseBtnVisible();
        }, 0.32);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Boss 章末庆祝
    // ══════════════════════════════════════════════════════════════════════════

    /** Boss 关过关庆祝：粒子爆发 + 额外音效 */
    private spawnBossCelebration(): void {
        if (!this.resultPanel) return;
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);

        // 在结算面板上层撒粒子（16 粒金色星点）
        for (let i = 0; i < 16; i++) {
            const p = new Node('celebration');
            p.parent = this.resultPanel;
            p.setPosition(0, 0, 0);
            const pUT = p.addComponent(UITransform);
            pUT.setAnchorPoint(0.5, 0.5);
            pUT.setContentSize(14, 14);
            const pSprite = p.addComponent(Sprite);
            pSprite.sizeMode = Sprite.SizeMode.CUSTOM;
            pSprite.trim = false;
            pSprite.spriteFrame = this.whiteFrame;
            pUT.setContentSize(14, 14);

            // 金色 / 橙色随机
            const useGold = Math.random() > 0.4;
            pSprite.color = useGold
                ? this.COLOR_CHAPTER_GOLD.clone()
                : new Color(0xFF, 0x9E, 0x4D);

            p.setScale(0.8 + Math.random() * 0.4, 0.8 + Math.random() * 0.4, 1);
            const pOp = p.addComponent(UIOpacity);
            pOp.opacity = 255;

            const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
            const dist = 150 + Math.random() * 100;
            const dx = Math.cos(angle) * dist;
            const dy = Math.sin(angle) * dist + 50; // 略微上飘

            tween(p)
                .to(0.6, { position: new Vec3(dx, dy, 0) }, { easing: 'quadOut' })
                .start();
            tween(p)
                .delay(0.3)
                .to(0.3, { scale: new Vec3(0, 0, 1) })
                .call(() => { if (p.isValid) p.destroy(); })
                .start();
            tween(pOp)
                .to(0.6, { opacity: 0 })
                .start();
        }

        // 额外庆祝音效（复用 win）
        AudioManager.inst?.playWin();
        console.log('[GameManager] ★ Boss 章末庆祝！');
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  装扮页（Q1）
    // ══════════════════════════════════════════════════════════════════════════

    private createDressupPanel(): void {
        this.dressupPanel = new Node('DressupPanel');
        this.dressupPanel.parent = this.node.parent!;
        const panelUT = this.dressupPanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.dressupPanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask
        const maskNode = new Node('Mask');
        maskNode.parent = this.dressupPanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 160);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity);
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card
        const cardW = 640, cardH = 680;
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.dressupPanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(-(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2, cardW + sPad * 2, cardH + sPad * 2, 28 + sPad);
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: 0 });

        const card = new Node('Card');
        card.parent = this.dressupPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 0 });
        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        // ── 手动定位（与图鉴页一致） ──
        const padding = 32;
        const spacing = 12;
        const titleH = 50;
        const previewH = 160;
        const groupTitleH = 30;
        const cellH = 90;
        const backH = 64;
        const backBottomMargin = 32;
        let cursorY = this.safeNum(cardH / 2 - padding, 308);

        // Title
        const titleLabel = this.createLabel(card, 'Title', '👗 装扮', 44, this.COLOR_TITLE_WIN);
        titleLabel.isBold = true;
        const titleW = this.safeNum(cardW - 80, 560);
        titleLabel.node.getComponent(UITransform)!.setContentSize(titleW, titleH);
        titleLabel.overflow = Label.Overflow.SHRINK;
        titleLabel.enableWrapText = false;
        cursorY = this.safeNum(cursorY - titleH / 2, 0);
        titleLabel.node.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - titleH / 2 - spacing, 0);

        // ── 展示台预览 ──
        const previewNode = new Node('Preview');
        previewNode.parent = card;
        previewNode.addComponent(UITransform).setContentSize(cardW - 60, previewH);
        cursorY = this.safeNum(cursorY - previewH / 2, 0);
        previewNode.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - previewH / 2 - spacing, 0);

        // 预览圆背景（主题色）
        const previewBgNode = new Node('PreviewBg');
        previewBgNode.parent = previewNode;
        previewBgNode.addComponent(UITransform).setContentSize(140, 140);
        previewBgNode.setPosition(0, 0, 0);
        this.dressupPreviewBg = previewBgNode.addComponent(Graphics);

        // 预览怪物 emoji
        const previewEmojiNode = new Node('PreviewEmoji');
        previewEmojiNode.parent = previewNode;
        previewEmojiNode.addComponent(UITransform).setContentSize(140, 140);
        previewEmojiNode.setPosition(0, 0, 0);
        const previewEmojiLabel = previewEmojiNode.addComponent(Label);
        previewEmojiLabel.string = '🐰';
        previewEmojiLabel.fontSize = 72;
        previewEmojiLabel.lineHeight = 76;
        previewEmojiLabel.color = Color.WHITE.clone();
        previewEmojiLabel.useSystemFont = true;
        previewEmojiLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        previewEmojiLabel.verticalAlign = Label.VerticalAlign.CENTER;
        previewEmojiLabel.overflow = Label.Overflow.NONE;
        this.dressupPreviewEmoji = previewEmojiLabel;

        // 预览配饰 emoji（叠在右上角）
        const previewAccNode = new Node('PreviewAcc');
        previewAccNode.parent = previewNode;
        previewAccNode.addComponent(UITransform).setContentSize(60, 60);
        previewAccNode.setPosition(48, 48, 0);
        const previewAccLabel = previewAccNode.addComponent(Label);
        previewAccLabel.string = '';
        previewAccLabel.fontSize = 40;
        previewAccLabel.lineHeight = 44;
        previewAccLabel.color = Color.WHITE.clone();
        previewAccLabel.useSystemFont = true;
        previewAccLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        previewAccLabel.verticalAlign = Label.VerticalAlign.CENTER;
        previewAccLabel.overflow = Label.Overflow.NONE;
        this.dressupPreviewAcc = previewAccLabel;

        // ── 主题区 ──
        const themeTitle = this.createLabel(card, 'ThemeTitle', '🎨 主题', 30, this.COLOR_HUD_TEXT);
        themeTitle.isBold = true;
        themeTitle.node.getComponent(UITransform)!.setContentSize(cardW - 80, groupTitleH);
        themeTitle.overflow = Label.Overflow.SHRINK;
        cursorY = this.safeNum(cursorY - groupTitleH / 2, 0);
        themeTitle.node.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - groupTitleH / 2 - spacing, 0);

        // 主题行
        const cellW = 132;
        const cellGap = 8;
        const themeRowW = this.safeNum(4 * cellW + 3 * cellGap, 552);
        const themeRow = new Node('ThemeRow');
        themeRow.parent = card;
        themeRow.addComponent(UITransform).setContentSize(themeRowW, cellH);
        cursorY = this.safeNum(cursorY - cellH / 2, 0);
        themeRow.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - cellH / 2 - spacing, 0);

        const themeRowLayout = themeRow.addComponent(Layout);
        themeRowLayout.type = Layout.Type.HORIZONTAL;
        themeRowLayout.spacingX = cellGap;
        themeRowLayout.horizontalDirection = Layout.HorizontalDirection.LEFT_TO_RIGHT;
        themeRowLayout.verticalDirection = Layout.VerticalDirection.CENTER;
        themeRowLayout.resizeMode = Layout.ResizeMode.NONE;

        for (let i = 0; i < 4; i++) {
            this.createDressupThemeCell(themeRow, i, cellW, cellH);
        }

        // ── 配饰区 ──
        const accTitle = this.createLabel(card, 'AccTitle', '✨ 配饰', 30, this.COLOR_HUD_TEXT);
        accTitle.isBold = true;
        accTitle.node.getComponent(UITransform)!.setContentSize(cardW - 80, groupTitleH);
        accTitle.overflow = Label.Overflow.SHRINK;
        cursorY = this.safeNum(cursorY - groupTitleH / 2, 0);
        accTitle.node.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - groupTitleH / 2 - spacing, 0);

        // 配饰行（4 个：无 + 3 个配饰）
        const accRow = new Node('AccRow');
        accRow.parent = card;
        accRow.addComponent(UITransform).setContentSize(themeRowW, cellH);
        cursorY = this.safeNum(cursorY - cellH / 2, 0);
        accRow.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - cellH / 2 - spacing, 0);

        const accRowLayout = accRow.addComponent(Layout);
        accRowLayout.type = Layout.Type.HORIZONTAL;
        accRowLayout.spacingX = cellGap;
        accRowLayout.horizontalDirection = Layout.HorizontalDirection.LEFT_TO_RIGHT;
        accRowLayout.verticalDirection = Layout.VerticalDirection.CENTER;
        accRowLayout.resizeMode = Layout.ResizeMode.NONE;

        this.createDressupAccessoryCell(accRow, -1, cellW, cellH);
        for (let i = 0; i < 3; i++) {
            this.createDressupAccessoryCell(accRow, i, cellW, cellH);
        }

        // ── 返回按钮 ──
        const backBtn = this.createRoundButton(card, 'BackBtn', '返回',
            this.COLOR_BTN_GIVEUP, 440, backH, () => this.onDressupBack(),
            { ghost: true });

        card.updateWorldTransform();
        const cardBox = card.getComponent(UITransform)!.getBoundingBoxToWorld();
        const actualCardH = this.safeNum(cardBox.height, cardH);
        const cardLocalBottomY = this.safeNum(-actualCardH / 2, -340);
        const backBtnY = this.safeNum(cardLocalBottomY + backBottomMargin + backH / 2, -276);
        backBtn.setPosition(0, backBtnY, 0);

        this.dressupPanel.active = false;
    }

    /** Q1: 创建主题格子 */
    private createDressupThemeCell(parent: Node, themeId: number, w: number, h: number): void {
        const node = new Node(`Theme${themeId}`);
        node.parent = parent;
        node.addComponent(UITransform).setContentSize(w, h);

        // 背景
        const bgNode = new Node('Bg');
        bgNode.parent = node;
        bgNode.addComponent(UITransform).setContentSize(w, h);
        const bg = bgNode.addComponent(Graphics);
        bg.fillColor = new Color(0xF0, 0xF0, 0xF0, 180);
        bg.roundRect(-w / 2, -h / 2, w, h, 12);
        bg.fill();

        // 主题色圆点
        const colorNode = new Node('ColorDot');
        colorNode.parent = node;
        colorNode.addComponent(UITransform).setContentSize(36, 36);
        colorNode.setPosition(0, h / 2 - 28, 0);
        const colorG = colorNode.addComponent(Graphics);
        colorG.fillColor = THEME_DATA[themeId].bg.clone();
        colorG.circle(0, 0, 16);
        colorG.fill();
        colorG.strokeColor = new Color(0, 0, 0, 30);
        colorG.lineWidth = 2;
        colorG.stroke();

        // 名称
        const nameNode = new Node('Name');
        nameNode.parent = node;
        nameNode.addComponent(UITransform).setContentSize(w, 22);
        nameNode.setPosition(0, -4, 0);
        const nameLabel = nameNode.addComponent(Label);
        nameLabel.string = THEME_DATA[themeId].name;
        nameLabel.fontSize = 18;
        nameLabel.lineHeight = 22;
        nameLabel.color = this.COLOR_TEXT_MAIN.clone();
        nameLabel.useSystemFont = true;
        nameLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        nameLabel.verticalAlign = Label.VerticalAlign.CENTER;
        nameLabel.overflow = Label.Overflow.SHRINK;

        // 状态
        const statusNode = new Node('Status');
        statusNode.parent = node;
        statusNode.addComponent(UITransform).setContentSize(w, 20);
        statusNode.setPosition(0, -28, 0);
        const statusLabel = statusNode.addComponent(Label);
        statusLabel.string = '';
        statusLabel.fontSize = 14;
        statusLabel.lineHeight = 18;
        statusLabel.color = this.COLOR_BTN_PRIMARY.clone();
        statusLabel.useSystemFont = true;
        statusLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        statusLabel.verticalAlign = Label.VerticalAlign.CENTER;
        statusLabel.overflow = Label.Overflow.SHRINK;

        // 点击按钮
        const btn = node.addComponent(Button);
        btn.transition = Button.Transition.NONE;
        btn.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            this.onDressupThemeSelect(themeId);
        }, this);

        this.dressupThemeCells.push({ id: themeId, node, statusLabel });
    }

    /** Q1: 创建配饰格子（id=-1 表示「无配饰」） */
    private createDressupAccessoryCell(parent: Node, accId: number, w: number, h: number): void {
        const node = new Node(`Acc${accId}`);
        node.parent = parent;
        node.addComponent(UITransform).setContentSize(w, h);

        // 背景
        const bgNode = new Node('Bg');
        bgNode.parent = node;
        bgNode.addComponent(UITransform).setContentSize(w, h);
        const bg = bgNode.addComponent(Graphics);
        bg.fillColor = new Color(0xF0, 0xF0, 0xF0, 180);
        bg.roundRect(-w / 2, -h / 2, w, h, 12);
        bg.fill();

        // Emoji
        const emojiNode = new Node('Emoji');
        emojiNode.parent = node;
        emojiNode.addComponent(UITransform).setContentSize(w, 40);
        emojiNode.setPosition(0, h / 2 - 30, 0);
        const emojiLabel = emojiNode.addComponent(Label);
        emojiLabel.string = accId === -1 ? '🚫' : (ACCESSORY_DATA[accId]?.emoji ?? '?');
        emojiLabel.fontSize = 32;
        emojiLabel.lineHeight = 36;
        emojiLabel.color = this.COLOR_TEXT_MAIN.clone();
        emojiLabel.useSystemFont = true;
        emojiLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        emojiLabel.verticalAlign = Label.VerticalAlign.CENTER;
        emojiLabel.overflow = Label.Overflow.NONE;

        // 名称
        const nameNode = new Node('Name');
        nameNode.parent = node;
        nameNode.addComponent(UITransform).setContentSize(w, 22);
        nameNode.setPosition(0, -4, 0);
        const nameLabel = nameNode.addComponent(Label);
        nameLabel.string = accId === -1 ? '无配饰' : (ACCESSORY_DATA[accId]?.name ?? '?');
        nameLabel.fontSize = 18;
        nameLabel.lineHeight = 22;
        nameLabel.color = this.COLOR_TEXT_MAIN.clone();
        nameLabel.useSystemFont = true;
        nameLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        nameLabel.verticalAlign = Label.VerticalAlign.CENTER;
        nameLabel.overflow = Label.Overflow.SHRINK;

        // 状态
        const statusNode = new Node('Status');
        statusNode.parent = node;
        statusNode.addComponent(UITransform).setContentSize(w, 20);
        statusNode.setPosition(0, -28, 0);
        const statusLabel = statusNode.addComponent(Label);
        statusLabel.string = '';
        statusLabel.fontSize = 14;
        statusLabel.lineHeight = 18;
        statusLabel.color = this.COLOR_BTN_PRIMARY.clone();
        statusLabel.useSystemFont = true;
        statusLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        statusLabel.verticalAlign = Label.VerticalAlign.CENTER;
        statusLabel.overflow = Label.Overflow.SHRINK;

        // 点击按钮
        const btn = node.addComponent(Button);
        btn.transition = Button.Transition.NONE;
        btn.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            this.onDressupAccessorySelect(accId);
        }, this);

        this.dressupAccessoryCells.push({ id: accId, node, statusLabel });
    }

    /** Q1: 获取预览用怪物 emoji（第一个已拥有的公仔，否则 🐰） */
    private getPreviewMonsterEmoji(): string {
        for (let i = 0; i < 6; i++) {
            const rec = SaveManager.inst.getMonster(i);
            if (this.safeNum(rec.count, 0) > 0) return COLOR_EMOJI_MAP[i] ?? '🐰';
        }
        return '🐰';
    }

    /** Q1: 绘制展示台预览圆背景 */
    private drawDressupPreview(): void {
        if (!this.dressupPreviewBg) return;
        const themeId = SaveManager.inst.getEquippedTheme();
        const g = this.dressupPreviewBg;
        g.clear();
        g.fillColor = THEME_DATA[themeId]?.bg.clone() ?? new Color(0xFD, 0xF2, 0xF8);
        g.strokeColor = new Color(0, 0, 0, 30);
        g.lineWidth = 3;
        g.circle(0, 0, 60);
        g.fill();
        g.stroke();
    }

    /** Q1: 刷新装扮页（预览 + 格子状态） */
    private refreshDressupPanel(): void {
        const equippedTheme = SaveManager.inst.getEquippedTheme();
        const equippedAcc = SaveManager.inst.getEquippedAccessory();
        const ownedThemes = SaveManager.inst.getOwnedThemes();
        const ownedAccessories = SaveManager.inst.getOwnedAccessories();

        // 展示台预览
        this.drawDressupPreview();
        if (this.dressupPreviewEmoji) {
            this.dressupPreviewEmoji.string = this.getPreviewMonsterEmoji();
        }
        if (this.dressupPreviewAcc) {
            this.dressupPreviewAcc.string = (equippedAcc >= 0) ? (ACCESSORY_DATA[equippedAcc]?.emoji ?? '') : '';
        }

        // 主题格子状态
        for (const cell of this.dressupThemeCells) {
            if (cell.id === equippedTheme) {
                cell.statusLabel.string = '✓ 已装备';
                cell.statusLabel.color = this.COLOR_CHAPTER_GOLD.clone();
            } else if (ownedThemes.includes(cell.id)) {
                cell.statusLabel.string = '点击装备';
                cell.statusLabel.color = this.COLOR_BTN_PRIMARY.clone();
            } else {
                cell.statusLabel.string = '📺 看广告';
                cell.statusLabel.color = this.COLOR_BTN_AD.clone();
            }
        }

        // 配饰格子状态
        for (const cell of this.dressupAccessoryCells) {
            if (cell.id === equippedAcc) {
                cell.statusLabel.string = '✓ 已装备';
                cell.statusLabel.color = this.COLOR_CHAPTER_GOLD.clone();
            } else if (cell.id === -1 || ownedAccessories.includes(cell.id)) {
                cell.statusLabel.string = '点击装备';
                cell.statusLabel.color = this.COLOR_BTN_PRIMARY.clone();
            } else {
                cell.statusLabel.string = '📺 看广告';
                cell.statusLabel.color = this.COLOR_BTN_AD.clone();
            }
        }
    }

    /** Q1: 显示装扮页 */
    private showDressupPanel(): void {
        if (!this.dressupPanel) return;
        this.refreshDressupPanel();
        this.showPanel(this.dressupPanel);
        this.gameClubEntry?.hide();
    }

    /** Q1: 装扮页返回 */
    private onDressupBack(): void {
        this.hidePanel(this.dressupPanel);
        this.showLevelSelectPanel();
    }

    /** Q1+Q2: 点击主题格子 — 已拥有则装备，未拥有则看广告解锁 */
    private onDressupThemeSelect(themeId: number): void {
        const ownedThemes = SaveManager.inst.getOwnedThemes();
        if (ownedThemes.includes(themeId)) {
            SaveManager.inst.setEquippedTheme(themeId);
            this.refreshDressupPanel();
            console.log(`[Dressup] 装备主题: ${THEME_DATA[themeId]?.name ?? '?'}`);
        } else {
            AdManager.getInstance().showRewardedAd(
                () => {
                    SaveManager.inst.ownTheme(themeId);
                    SaveManager.inst.setEquippedTheme(themeId);
                    this.refreshDressupPanel();
                    console.log(`[Dressup] 广告解锁并装备主题: ${THEME_DATA[themeId]?.name ?? '?'}`);
                },
                () => {
                    console.log('[Dressup] 广告未看完，主题未解锁');
                },
            );
        }
    }

    /** Q1+Q2: 点击配饰格子 — id=-1 卸下，已拥有则装备，未拥有则看广告解锁 */
    private onDressupAccessorySelect(accId: number): void {
        if (accId === -1) {
            SaveManager.inst.setEquippedAccessory(-1);
            this.refreshDressupPanel();
            console.log('[Dressup] 卸下配饰');
            return;
        }

        const ownedAccessories = SaveManager.inst.getOwnedAccessories();
        if (ownedAccessories.includes(accId)) {
            SaveManager.inst.setEquippedAccessory(accId);
            this.refreshDressupPanel();
            console.log(`[Dressup] 装备配饰: ${ACCESSORY_DATA[accId]?.name ?? '?'}`);
        } else {
            AdManager.getInstance().showRewardedAd(
                () => {
                    SaveManager.inst.ownAccessory(accId);
                    SaveManager.inst.setEquippedAccessory(accId);
                    this.refreshDressupPanel();
                    console.log(`[Dressup] 广告解锁并装备配饰: ${ACCESSORY_DATA[accId]?.name ?? '?'}`);
                },
                () => {
                    console.log('[Dressup] 广告未看完，配饰未解锁');
                },
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  设置面板（R2）
    // ══════════════════════════════════════════════════════════════════════════

    private createSettingsPanel(): void {
        this.settingsPanel = new Node('SettingsPanel');
        this.settingsPanel.parent = this.node.parent!;
        const panelUT = this.settingsPanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.settingsPanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask
        const maskNode = new Node('Mask');
        maskNode.parent = this.settingsPanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 160);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity);
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card
        const cardW = 560, cardH = 380;
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.settingsPanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(-(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2, cardW + sPad * 2, cardH + sPad * 2, 28 + sPad);
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: 0 });

        const card = new Node('Card');
        card.parent = this.settingsPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 0 });
        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        // ── 手动定位（不用 Layout）──
        const padding = 32;
        const spacing = 20;
        const titleH = 50;
        const rowH = 60;
        const closeBtnSize = 48;
        let cursorY = this.safeNum(cardH / 2 - padding, 158);

        // Title
        const titleLabel = this.createLabel(card, 'Title', '⚙️ 设置', 40, this.COLOR_TITLE_WIN);
        titleLabel.isBold = true;
        const titleW = this.safeNum(cardW - 80, 480);
        titleLabel.node.getComponent(UITransform)!.setContentSize(titleW, titleH);
        titleLabel.overflow = Label.Overflow.SHRINK;
        titleLabel.enableWrapText = false;
        cursorY = this.safeNum(cursorY - titleH / 2, 0);
        titleLabel.node.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - titleH / 2 - spacing, 0);

        // ── 音效开关行 ──
        const soundRow = new Node('SoundRow');
        soundRow.parent = card;
        soundRow.addComponent(UITransform).setContentSize(this.safeNum(cardW - 64, 496), rowH);
        cursorY = this.safeNum(cursorY - rowH / 2, 0);
        soundRow.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - rowH / 2 - spacing, 0);

        const soundLabel = this.createLabel(soundRow, 'SoundLabel', '🔊 音效', 30, this.COLOR_HUD_TEXT);
        soundLabel.isBold = true;
        soundLabel.node.getComponent(UITransform)!.setContentSize(200, rowH);
        soundLabel.overflow = Label.Overflow.SHRINK;
        soundLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        soundLabel.node.setPosition(this.safeNum(-this.safeNum(cardW - 64, 496) / 2 + 100, 0, 0), 0, 0);

        // 音效胶囊开关
        this.settingsSoundCapsule = this.createToggleCapsule(soundRow, 'SoundCapsule',
            this.safeNum(this.safeNum(cardW - 64, 496) / 2 - 50, 198), 0, () => this.onToggleSound());
        this.settingsSoundLabel = this.settingsSoundCapsule.getChildByName('StateLabel')?.getComponent(Label) ?? null;

        // ── 震动开关行 ──
        const vibrateRow = new Node('VibrateRow');
        vibrateRow.parent = card;
        vibrateRow.addComponent(UITransform).setContentSize(this.safeNum(cardW - 64, 496), rowH);
        cursorY = this.safeNum(cursorY - rowH / 2, 0);
        vibrateRow.setPosition(0, cursorY, 0);
        cursorY = this.safeNum(cursorY - rowH / 2 - spacing, 0);

        const vibrateLabel = this.createLabel(vibrateRow, 'VibrateLabel', '📳 震动', 30, this.COLOR_HUD_TEXT);
        vibrateLabel.isBold = true;
        vibrateLabel.node.getComponent(UITransform)!.setContentSize(200, rowH);
        vibrateLabel.overflow = Label.Overflow.SHRINK;
        vibrateLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
        vibrateLabel.node.setPosition(this.safeNum(-this.safeNum(cardW - 64, 496) / 2 + 100, 0, 0), 0, 0);

        // 震动胶囊开关
        this.settingsVibrateCapsule = this.createToggleCapsule(vibrateRow, 'VibrateCapsule',
            this.safeNum(this.safeNum(cardW - 64, 496) / 2 - 50, 198), 0, () => this.onToggleVibrate());
        this.settingsVibrateLabel = this.settingsVibrateCapsule.getChildByName('StateLabel')?.getComponent(Label) ?? null;

        // ── ✕ 关闭按钮（右上角）──
        const closeBtn = new Node('CloseBtn');
        closeBtn.parent = card;
        const closeUT = closeBtn.addComponent(UITransform);
        closeUT.setContentSize(closeBtnSize, closeBtnSize);
        closeUT.setAnchorPoint(0.5, 0.5);
        closeBtn.setPosition(this.safeNum(cardW / 2 - closeBtnSize / 2 - 12, 224), this.safeNum(cardH / 2 - closeBtnSize / 2 - 12, 142), 0);

        const closeG = closeBtn.addComponent(Graphics);
        closeG.fillColor = new Color(0xE0, 0xE0, 0xE0, 200);
        closeG.circle(0, 0, closeBtnSize / 2);
        closeG.fill();

        const closeLabelNode = new Node('CloseLabel');
        closeLabelNode.parent = closeBtn;
        closeLabelNode.addComponent(UITransform).setContentSize(closeBtnSize, closeBtnSize);
        const closeLabel = closeLabelNode.addComponent(Label);
        closeLabel.string = '✕';
        closeLabel.fontSize = 24;
        closeLabel.lineHeight = 28;
        closeLabel.color = this.COLOR_HUD_TEXT.clone();
        closeLabel.useSystemFont = true;
        closeLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        closeLabel.verticalAlign = Label.VerticalAlign.CENTER;

        const closeButton = closeBtn.addComponent(Button);
        closeButton.transition = Button.Transition.NONE;
        closeButton.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(closeBtn);
            closeBtn.setScale(0.9, 0.9, 1);
            tween(closeBtn)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        closeButton.node.on(Button.EventType.CLICK, () => this.onSettingsClose(), this);

        this.settingsPanel.active = false;
    }

    /** R2: 创建胶囊开关（绿=开/灰=关），返回 capsule 节点 */
    private createToggleCapsule(parent: Node, name: string, x: number, y: number, onToggle: () => void): Node {
        const capsuleW = 100;
        const capsuleH = 44;

        const node = new Node(name);
        node.parent = parent;
        const ut = node.addComponent(UITransform);
        ut.setContentSize(capsuleW, capsuleH);
        ut.setAnchorPoint(0.5, 0.5);
        node.setPosition(x, y, 0);

        const bg = node.addComponent(Graphics);
        // 默认画绿色（开）
        bg.fillColor = new Color(0x7B, 0xC6, 0x7B);
        bg.roundRect(-capsuleW / 2, -capsuleH / 2, capsuleW, capsuleH, capsuleH / 2);
        bg.fill();

        // 圆点（滑块）
        const dotNode = new Node('Dot');
        dotNode.parent = node;
        dotNode.addComponent(UITransform).setContentSize(capsuleH - 8, capsuleH - 8);
        // 默认在右侧（开）
        dotNode.setPosition(capsuleW / 2 - capsuleH / 2, 0, 0);
        const dotG = dotNode.addComponent(Graphics);
        dotG.fillColor = Color.WHITE.clone();
        dotG.circle(0, 0, (capsuleH - 8) / 2);
        dotG.fill();

        // 状态文字（ON/OFF）
        const stateNode = new Node('StateLabel');
        stateNode.parent = node;
        stateNode.addComponent(UITransform).setContentSize(capsuleW, capsuleH);
        const stateLabel = stateNode.addComponent(Label);
        stateLabel.string = 'ON';
        stateLabel.fontSize = 16;
        stateLabel.lineHeight = 20;
        stateLabel.color = Color.WHITE.clone();
        stateLabel.useSystemFont = true;
        stateLabel.isBold = true;
        stateLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        stateLabel.verticalAlign = Label.VerticalAlign.CENTER;

        // 点击按钮
        const btn = node.addComponent(Button);
        btn.transition = Button.Transition.NONE;
        btn.node.on(Button.EventType.CLICK, () => {
            try { AudioManager.inst?.playClick(); } catch (e) { /* ignore */ }
            Tween.stopAllByTarget(node);
            node.setScale(0.92, 0.92, 1);
            tween(node)
                .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }, this);
        btn.node.on(Button.EventType.CLICK, onToggle, this);

        return node;
    }

    /** R2: 刷新胶囊开关外观 */
    private refreshToggleCapsule(capsule: Node, stateLabel: Label, enabled: boolean): void {
        if (!capsule) return;
        const capsuleW = 100;
        const capsuleH = 44;

        // 重绘背景
        const bg = capsule.getComponent(Graphics);
        if (bg) {
            bg.clear();
            bg.fillColor = enabled ? new Color(0x7B, 0xC6, 0x7B) : new Color(0xC8, 0xC8, 0xC8);
            bg.roundRect(-capsuleW / 2, -capsuleH / 2, capsuleW, capsuleH, capsuleH / 2);
            bg.fill();
        }

        // 移动滑块
        const dot = capsule.getChildByName('Dot');
        if (dot) {
            Tween.stopAllByTarget(dot);
            const targetX = enabled ? (capsuleW / 2 - capsuleH / 2) : -(capsuleW / 2 - capsuleH / 2);
            tween(dot)
                .to(0.15, { position: new Vec3(targetX, 0, 0) }, { easing: 'quadOut' })
                .start();
        }

        // 更新文字
        if (stateLabel) {
            stateLabel.string = enabled ? 'ON' : 'OFF';
        }
    }

    /** R2: 显示设置面板，按存档初始化胶囊 */
    private showSettingsPanel(): void {
        if (!this.settingsPanel) return;
        // 按存档初始化胶囊
        const soundOn = SaveManager.inst.getSoundEnabled();
        const vibrateOn = SaveManager.inst.getVibrateEnabled();
        this.refreshToggleCapsule(this.settingsSoundCapsule!, this.settingsSoundLabel!, soundOn);
        this.refreshToggleCapsule(this.settingsVibrateCapsule!, this.settingsVibrateLabel!, vibrateOn);
        this.showPanel(this.settingsPanel);
        this.gameClubEntry?.hide();
    }

    /** R2: 关闭设置面板 */
    private onSettingsClose(): void {
        this.hidePanel(this.settingsPanel);
        this.showLevelSelectPanel();
    }

    /** R2: 切换音效开关 */
    private onToggleSound(): void {
        const current = SaveManager.inst.getSoundEnabled();
        const newVal = !current;
        try { AudioManager.inst?.setEnabled(newVal); } catch (e) { /* ignore */ }
        SaveManager.inst.setSoundEnabled(newVal);
        this.refreshToggleCapsule(this.settingsSoundCapsule!, this.settingsSoundLabel!, newVal);
        console.log(`[Settings] 音效 → ${newVal ? 'ON' : 'OFF'}`);
    }

    /** R2: 切换震动开关 */
    private onToggleVibrate(): void {
        const current = SaveManager.inst.getVibrateEnabled();
        const newVal = !current;
        try { VibrateManager.inst?.setVibrateEnabled(newVal); } catch (e) { /* ignore */ }
        SaveManager.inst.setVibrateEnabled(newVal);
        this.refreshToggleCapsule(this.settingsVibrateCapsule!, this.settingsVibrateLabel!, newVal);
        console.log(`[Settings] 震动 → ${newVal ? 'ON' : 'OFF'}`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  每日签到（R3）
    // ══════════════════════════════════════════════════════════════════════════

    /** R3: 每日签到奖励表（7天） */
    private static readonly SIGN_REWARDS: { coins: number; extra: string }[] = [
        { coins: 20, extra: '' },
        { coins: 30, extra: '' },
        { coins: 40, extra: '' },
        { coins: 50, extra: '' },
        { coins: 60, extra: '' },
        { coins: 80, extra: '' },
        { coins: 100, extra: '+🎁免费抽' },
    ];

    /** R3: 获取今日日期字符串 YYYY-MM-DD */
    private getTodayStr(): string {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    /** R3: 计算两个日期字符串相差的天数（同日=0，昨天=1，前天=2...） */
    private daysBetween(dateStr1: string, dateStr2: string): number {
        if (!dateStr1 || !dateStr2) return -1;
        try {
            const d1 = new Date(dateStr1 + 'T00:00:00');
            const d2 = new Date(dateStr2 + 'T00:00:00');
            if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return -1;
            const diff = Math.round((d2.getTime() - d1.getTime()) / (24 * 60 * 60 * 1000));
            return diff;
        } catch (e) {
            return -1;
        }
    }

    /** R3: 计算今日应签到的 streak（未领取状态） */
    private calcTodayStreak(): number {
        const signData = SaveManager.inst.getSignData();
        const today = this.getTodayStr();

        if (!signData.lastDate || signData.lastDate === '') {
            // 首次签到
            return 1;
        }

        if (signData.lastDate === today) {
            // 今天已签
            return signData.streak;
        }

        const diff = this.daysBetween(signData.lastDate, today);
        if (diff === 1) {
            // 连签
            const next = signData.streak + 1;
            return next > 7 ? 1 : next; // 超过7回到1
        } else {
            // 断签重置
            return 1;
        }
    }

    /** R3: 今日是否已签到 */
    private isSignedToday(): boolean {
        const signData = SaveManager.inst.getSignData();
        return signData.lastDate === this.getTodayStr();
    }

    private createDailySignPanel(): void {
        this.dailySignPanel = new Node('DailySignPanel');
        this.dailySignPanel.parent = this.node.parent!;
        const panelUT = this.dailySignPanel.addComponent(UITransform);
        const pw = this.safeNum(this.canvasW, 720);
        const ph = this.safeNum(this.canvasH, 1280);
        panelUT.setContentSize(pw, ph);
        this.addWidget(this.dailySignPanel, { top: 0, bottom: 0, left: 0, right: 0 });

        // Mask
        const maskNode = new Node('Mask');
        maskNode.parent = this.dailySignPanel;
        const maskUT = maskNode.addComponent(UITransform);
        maskUT.setContentSize(pw, ph);
        const maskG = maskNode.addComponent(Graphics);
        maskG.fillColor = new Color(0, 0, 0, 160);
        maskG.rect(-pw / 2, -ph / 2, pw, ph);
        maskG.fill();
        maskNode.addComponent(BlockInputEvents);
        maskNode.addComponent(UIOpacity);
        this.addWidget(maskNode, { top: 0, bottom: 0, left: 0, right: 0 });

        // Card
        const cardW = 640, cardH = 640;
        const shadowNode = new Node('CardShadow');
        shadowNode.parent = this.dailySignPanel;
        const shadowUT = shadowNode.addComponent(UITransform);
        const sPad = 14;
        shadowUT.setContentSize(cardW + sPad * 2, cardH + sPad * 2);
        const shadowG = shadowNode.addComponent(Graphics);
        shadowG.fillColor = new Color(0, 0, 0, 50);
        shadowG.roundRect(-(cardW + sPad * 2) / 2, -(cardH + sPad * 2) / 2, cardW + sPad * 2, cardH + sPad * 2, 28 + sPad);
        shadowG.fill();
        shadowNode.addComponent(UIOpacity);
        this.addWidget(shadowNode, { hCenter: 0, vCenter: 0 });

        const card = new Node('Card');
        card.parent = this.dailySignPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 0 });
        const cardG = card.addComponent(Graphics);
        cardG.fillColor = this.COLOR_CARD.clone();
        cardG.strokeColor = this.COLOR_CARD_BORDER.clone();
        cardG.lineWidth = 2;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardG.fill();
        cardG.stroke();

        // ── 手动定位（确定性坐标，不依赖 Layout）──
        const cellW = 80;
        const cellH = 110;
        const cellGap = 6;
        const stepX = cellW + cellGap;

        // Title
        const titleLabel = this.createLabel(card, 'Title', '📅 每日签到', 40, this.COLOR_TITLE_WIN);
        titleLabel.isBold = true;
        const titleW = this.safeNum(cardW - 80, 560);
        titleLabel.node.getComponent(UITransform)!.setContentSize(titleW, 50);
        titleLabel.overflow = Label.Overflow.SHRINK;
        titleLabel.enableWrapText = false;
        titleLabel.node.setPosition(0, 265, 0);

        // 提示文案
        const hintLabel = this.createLabel(card, 'Hint', '连续签到奖励递增，断签重置哦~', 22, this.COLOR_TEXT_MAIN);
        hintLabel.node.getComponent(UITransform)!.setContentSize(this.safeNum(cardW - 80, 560), 28);
        hintLabel.overflow = Label.Overflow.SHRINK;
        hintLabel.node.setPosition(0, 220, 0);

        // ── 7 格日历（两排：上3下4，手动定位）──
        const topRow = new Node('TopRow');
        topRow.parent = card;
        topRow.addComponent(UITransform).setContentSize(3 * cellW + 2 * cellGap, cellH);
        topRow.setPosition(0, 140, 0);

        const bottomRow = new Node('BottomRow');
        bottomRow.parent = card;
        bottomRow.addComponent(UITransform).setContentSize(4 * cellW + 3 * cellGap, cellH);
        bottomRow.setPosition(0, 15, 0);

        const topX = [-stepX, 0, stepX];
        const bottomX = [
            -stepX * 1.5,
            -stepX * 0.5,
             stepX * 0.5,
             stepX * 1.5,
        ];

        for (let i = 0; i < 3; i++) {
            const cell = this.createSignCell(topRow, i, cellW, cellH);
            cell.setPosition(topX[i], 0, 0);
        }

        for (let i = 0; i < 4; i++) {
            const dayIdx = i + 3;
            const cell = this.createSignCell(bottomRow, dayIdx, cellW, cellH);
            cell.setPosition(bottomX[i], 0, 0);
        }

        // ── 领取按钮 ──
        this.dailySignClaimBtn = this.createRoundButton(card, 'ClaimBtn', '',
            this.COLOR_BTN_AD, 440, 64, () => this.onSignClaim());
        this.dailySignClaimLabel = this.dailySignClaimBtn.getChildByName('Label')?.getComponent(Label) ?? null;
        this.dailySignClaimBtn.setPosition(0, -160, 0);

        // ── 关闭按钮 ──
        const backBtn = this.createRoundButton(card, 'BackBtn', '关闭',
            this.COLOR_BTN_GIVEUP, 440, 56, () => this.onDailySignClose(),
            { ghost: true });
        backBtn.setPosition(0, -240, 0);

        this.dailySignPanel.active = false;
    }

    /** R3: 创建单个签到格子 */
    private createSignCell(parent: Node, dayIdx: number, w: number, h: number): Node {
        const node = new Node(`Day${dayIdx + 1}`);
        node.parent = parent;
        node.addComponent(UITransform).setContentSize(w, h);

        const bgNode = new Node('Bg');
        bgNode.parent = node;
        bgNode.addComponent(UITransform).setContentSize(w, h);
        const bg = bgNode.addComponent(Graphics);
        bg.fillColor = new Color(0xF0, 0xF0, 0xF0, 180);
        bg.roundRect(-w / 2, -h / 2, w, h, 10);
        bg.fill();

        // 天数标签
        const dayNode = new Node('DayLabel');
        dayNode.parent = node;
        dayNode.addComponent(UITransform).setContentSize(w, 22);
        dayNode.setPosition(0, h / 2 - 16, 0);
        const dayLabel = dayNode.addComponent(Label);
        dayLabel.string = `第${dayIdx + 1}天`;
        dayLabel.fontSize = 16;
        dayLabel.lineHeight = 20;
        dayLabel.color = this.COLOR_HUD_TEXT.clone();
        dayLabel.useSystemFont = true;
        dayLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        dayLabel.verticalAlign = Label.VerticalAlign.CENTER;
        dayLabel.overflow = Label.Overflow.SHRINK;

        // 奖励标签
        const rewardNode = new Node('RewardLabel');
        rewardNode.parent = node;
        rewardNode.addComponent(UITransform).setContentSize(w, 40);
        rewardNode.setPosition(0, 0, 0);
        const rewardLabel = rewardNode.addComponent(Label);
        const reward = GameManager.SIGN_REWARDS[dayIdx];
        rewardLabel.string = `${reward.coins}🎲`;
        rewardLabel.fontSize = 22;
        rewardLabel.lineHeight = 26;
        rewardLabel.color = this.COLOR_CHAPTER_GOLD.clone();
        rewardLabel.useSystemFont = true;
        rewardLabel.isBold = true;
        rewardLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        rewardLabel.verticalAlign = Label.VerticalAlign.CENTER;
        rewardLabel.overflow = Label.Overflow.SHRINK;

        // 状态标签
        const statusNode = new Node('StatusLabel');
        statusNode.parent = node;
        statusNode.addComponent(UITransform).setContentSize(w, 20);
        statusNode.setPosition(0, -h / 2 + 14, 0);
        const statusLabel = statusNode.addComponent(Label);
        statusLabel.string = '';
        statusLabel.fontSize = 14;
        statusLabel.lineHeight = 18;
        statusLabel.color = this.COLOR_TEXT_MAIN.clone();
        statusLabel.useSystemFont = true;
        statusLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
        statusLabel.verticalAlign = Label.VerticalAlign.CENTER;
        statusLabel.overflow = Label.Overflow.SHRINK;

        // 第7天额外奖励
        if (reward.extra) {
            const extraNode = new Node('ExtraLabel');
            extraNode.parent = node;
            extraNode.addComponent(UITransform).setContentSize(w, 18);
            extraNode.setPosition(0, -h / 2 + 32, 0);
            const extraLabel = extraNode.addComponent(Label);
            extraLabel.string = reward.extra;
            extraLabel.fontSize = 12;
            extraLabel.lineHeight = 16;
            extraLabel.color = this.COLOR_BTN_AD.clone();
            extraLabel.useSystemFont = true;
            extraLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
            extraLabel.verticalAlign = Label.VerticalAlign.CENTER;
            extraLabel.overflow = Label.Overflow.SHRINK;
        }

        this.dailySignCells.push({ node, bg, dayLabel, rewardLabel, statusLabel });
        return node;
    }

    /** R3: 刷新签到格子三态 + 领取按钮 */
    private refreshDailySignPanel(): void {
        const signData = SaveManager.inst.getSignData();
        const today = this.getTodayStr();
        const signedToday = signData.lastDate === today;
        const todayStreak = this.calcTodayStreak();

        for (let i = 0; i < 7; i++) {
            const cell = this.dailySignCells[i];
            if (!cell) continue;
            const dayNum = i + 1; // 第1~7天

            // X1: 恢复基础状态，避免高亮残留
            cell.node.active = true;
            cell.dayLabel.color = this.COLOR_HUD_TEXT.clone();
            cell.statusLabel.color = this.COLOR_TEXT_MAIN.clone();

            if (signedToday) {
                // 今天已签
                if (dayNum <= signData.streak) {
                    // 已领
                    cell.bg.clear();
                    cell.bg.fillColor = new Color(0xE0, 0xE0, 0xE0, 150);
                    cell.bg.roundRect(-40, -55, 80, 110, 10);
                    cell.bg.fill();
                    cell.statusLabel.string = '✓';
                    cell.statusLabel.color = this.COLOR_BTN_PRIMARY.clone();
                    cell.rewardLabel.color = new Color(0x99, 0x99, 0x99);
                } else {
                    // 未来
                    cell.bg.clear();
                    cell.bg.fillColor = new Color(0xF0, 0xF0, 0xF0, 100);
                    cell.bg.roundRect(-40, -55, 80, 110, 10);
                    cell.bg.fill();
                    cell.statusLabel.string = '';
                    cell.rewardLabel.color = new Color(0x99, 0x99, 0x99);
                }
            } else {
                // 今天未签
                if (dayNum < todayStreak) {
                    // 已领
                    cell.bg.clear();
                    cell.bg.fillColor = new Color(0xE0, 0xE0, 0xE0, 150);
                    cell.bg.roundRect(-40, -55, 80, 110, 10);
                    cell.bg.fill();
                    cell.statusLabel.string = '✓';
                    cell.statusLabel.color = this.COLOR_BTN_PRIMARY.clone();
                    cell.rewardLabel.color = new Color(0x99, 0x99, 0x99);
                } else if (dayNum === todayStreak) {
                    // 今日可领
                    cell.bg.clear();
                    cell.bg.fillColor = this.COLOR_CHAPTER_GOLD.clone();
                    cell.bg.roundRect(-40, -55, 80, 110, 10);
                    cell.bg.fill();
                    cell.statusLabel.string = '今日';
                    cell.statusLabel.color = Color.WHITE.clone();
                    cell.rewardLabel.color = Color.WHITE.clone();
                    cell.dayLabel.color = Color.WHITE.clone();
                } else {
                    // 未来
                    cell.bg.clear();
                    cell.bg.fillColor = new Color(0xF0, 0xF0, 0xF0, 100);
                    cell.bg.roundRect(-40, -55, 80, 110, 10);
                    cell.bg.fill();
                    cell.statusLabel.string = '';
                    cell.rewardLabel.color = new Color(0x99, 0x99, 0x99);
                }
            }
        }

        // 刷新领取按钮
        if (this.dailySignClaimBtn && this.dailySignClaimLabel) {
            const btn = this.dailySignClaimBtn.getComponent(Button);
            if (signedToday) {
                this.dailySignClaimLabel.string = '今日已签 ✓';
                if (btn) btn.interactable = false;
            } else {
                const reward = GameManager.SIGN_REWARDS[todayStreak - 1];
                this.dailySignClaimLabel.string = `领取 ${reward.coins}🎲${reward.extra ? ' ' + reward.extra : ''}`;
                if (btn) btn.interactable = true;
            }
        }
    }

    /** R3: 显示签到面板 */
    private showDailySignPanel(): void {
        if (!this.dailySignPanel) return;
        this.refreshDailySignPanel();
        this.showPanel(this.dailySignPanel);
        this.gameClubEntry?.hide();
    }

    /** R3: 关闭签到面板 */
    private onDailySignClose(): void {
        this.hidePanel(this.dailySignPanel);
        this.showLevelSelectPanel();
    }

    /** R3: 领取签到奖励 */
    private onSignClaim(): void {
        if (this.isSignedToday()) return; // 同天不可重领

        const todayStreak = this.calcTodayStreak();
        const signData = SaveManager.inst.getSignData();
        const reward = GameManager.SIGN_REWARDS[todayStreak - 1];
        const today = this.getTodayStr();

        // 发金币
        const coins = this.safeNum(reward.coins, 20);
        SaveManager.inst.addCoins(coins);

        // 第7天额外发等值金币占位（100币 = 1次抽卡券等值）
        if (todayStreak === 7 && reward.extra) {
            SaveManager.inst.addCoins(100); // 占位：等值1次免费单抽
        }

        // 写签到数据
        const newTotal = this.safeNum(signData.total, 0) + 1;
        SaveManager.inst.writeSignData(todayStreak, today, newTotal);

        console.log(`[Sign] 签到成功: 第${todayStreak}天, +${coins}🎲, total=${newTotal}`);

        // 刷新面板
        this.refreshDailySignPanel();
    }
}

</file>

<file path="assets/scripts/AudioManager.ts">
(290 lines)

import { _decorator, Component, AudioClip, AudioSource, resources } from 'cc';
import { SaveManager } from './SaveManager';
const { ccclass } = _decorator;

// 微信小游戏全局 API
declare const wx: any;

@ccclass('AudioManager')
export class AudioManager extends Component {
    private static _inst: AudioManager | null = null;
    public static get inst(): AudioManager | null { return AudioManager._inst; }

    volume: number = 0.8;
    private _src!: AudioSource;
    private _clips: Record<string, AudioClip | null> = {
        click: null, swap: null, match: null, fall: null, win: null, lose: null,
        fx_line: null, fx_bomb: null, fx_colorbomb: null,
    };
    private _combo: (AudioClip | null)[] = [null, null, null, null, null, null]; // 下标 1..5

    // 微信原生 InnerAudioContext（每个音效一个，复用）
    private _wxCtxs: Record<string, any> = {};
    private _wxCtxCombo: any[] = [null, null, null, null, null, null];
    private _isWeChat = false;

    // R1: 静音总开关
    private _enabled = true;

    onLoad() {
        AudioManager._inst = this;
        this._isWeChat = typeof wx !== 'undefined' && typeof wx.createInnerAudioContext === 'function';

        // R1: 从存档读取音效开关
        try {
            this._enabled = SaveManager.inst.getSoundEnabled();
        } catch (e) {
            this._enabled = true; // 读不到就默认开
        }

        // 非微信环境才用 Cocos AudioSource
        if (!this._isWeChat) {
            this._src = this.getComponent(AudioSource) || this.addComponent(AudioSource);
            this._src.loop = false;
        }

        for (const name of Object.keys(this._clips)) {
            resources.load(`audio/${name}`, AudioClip, (e, c) => {
                if (!e && c) {
                    this._clips[name] = c;
                    if (this._isWeChat) this._createWxCtx(name, c);
                }
            });
        }
        for (let i = 1; i <= 5; i++) {
            resources.load(`audio/combo${i}`, AudioClip, (e, c) => {
                if (!e && c) {
                    this._combo[i] = c;
                    if (this._isWeChat) this._createWxCtxCombo(i, c);
                }
            });
        }
    }

    /** 用 AudioClip 的 nativeUrl 创建微信 InnerAudioContext */
    private _createWxCtx(name: string, clip: AudioClip): void {
        const src = clip.nativeUrl;
        if (!src) { console.warn(`[Audio] nativeUrl 为空: ${name}`); return; }
        const ctx = wx.createInnerAudioContext();
        ctx.src = src;
        ctx.volume = this.volume;
        ctx.obeyMuteSwitch = false; // 关键：iOS 静音模式下也能播放
        ctx.onError((r: any) => console.error('AUDIO_ERR', name, r.errCode, r.errMsg));
        this._wxCtxs[name] = ctx;
        console.log(`[Audio] wx ctx created: ${name} -> ${src}`);
    }

    private _createWxCtxCombo(idx: number, clip: AudioClip): void {
        const src = clip.nativeUrl;
        if (!src) { console.warn(`[Audio] nativeUrl 为空: combo${idx}`); return; }
        const ctx = wx.createInnerAudioContext();
        ctx.src = src;
        ctx.volume = this.volume;
        ctx.obeyMuteSwitch = false;
        ctx.onError((r: any) => console.error('AUDIO_ERR', `combo${idx}`, r.errCode, r.errMsg));
        this._wxCtxCombo[idx] = ctx;
        console.log(`[Audio] wx ctx created: combo${idx} -> ${src}`);
    }

    onDestroy() {
        if (AudioManager._inst === this) AudioManager._inst = null;
        if (this._isWeChat) {
            for (const k in this._wxCtxs) { try { this._wxCtxs[k]?.destroy(); } catch (e) { /* ignore */ } }
            for (let i = 1; i <= 5; i++) { try { this._wxCtxCombo[i]?.destroy(); } catch (e) { /* ignore */ } }
        }
    }

    private _play(name: string): void {
        if (!this._enabled) return; // R1: 静音守卫
        const clip = this._clips[name];
        if (!clip) return;

        if (this._isWeChat && this._wxCtxs[name]) {
            // 微信原生播放
            const ctx = this._wxCtxs[name];
            ctx.stop();
            ctx.volume = this.volume;
            ctx.play();
        } else if (this._src) {
            // Cocos AudioSource 播放（开发者工具/浏览器）
            this._src.clip = clip;
            this._src.volume = this.volume;
            this._src.play();
        }
    }

    /** T2: 带音量加成的播放（特效音用，volMult>1 提升音量） */
    private _playVol(name: string, volMult: number): void {
        if (!this._enabled) return;
        const clip = this._clips[name];
        if (!clip) return;
        const vol = Math.min(1, this.volume * volMult);
        if (this._isWeChat && this._wxCtxs[name]) {
            const ctx = this._wxCtxs[name];
            ctx.stop();
            ctx.volume = vol;
            ctx.play();
        } else if (this._src) {
            this._src.clip = clip;
            this._src.volume = vol;
            this._src.play();
        }
    }

    playClick() { this._play('click'); }
    playSwap()  { this._play('swap'); }
    playMatch() { this._play('match'); }
    playFall()  { this._play('fall'); }
    playWin()   { this._play('win'); }
    playLose()  { this._play('lose'); }

    // T2: 特效音效——专属 clip 优先 → 差异化降级（比普通消除更重/更亮） → match/win 兜底
    playSpecialLine(): void {
        try {
            if (this._clips['fx_line']) { this._playVol('fx_line', 1.15); return; }
            // 降级：combo3 单发（比普通 match 高一档）
            if (this._playComboClipVol(3, 1.15)) return;
            this._play('match'); // 最终兜底
        } catch (e) { try { this._play('match'); } catch (_) { /* ignore */ } }
    }
    playSpecialBomb(): void {
        if (!this._enabled) return;
        try {
            if (this._clips['fx_bomb']) { this._playVol('fx_bomb', 1.2); return; }
            // 降级：微信环境叠播 match+win 制造「轰」感；非微信走 combo1 低音
            if (this._isWeChat) {
                let played = false;
                if (this._wxCtxs['match']) {
                    try { this._wxCtxs['match'].stop(); this._wxCtxs['match'].volume = Math.min(1, this.volume * 1.2); this._wxCtxs['match'].play(); } catch (_) { /* ignore */ }
                    played = true;
                }
                if (this._wxCtxs['win']) {
                    try { this._wxCtxs['win'].stop(); this._wxCtxs['win'].volume = Math.min(1, this.volume * 1.2); this._wxCtxs['win'].play(); } catch (_) { /* ignore */ }
                    played = true;
                }
                if (played) return;
            }
            // 非微信或无 match/win：combo1 最低音
            if (this._playComboClipVol(1, 1.2)) return;
            this._play('match'); // 最终兜底
        } catch (e) { try { this._play('match'); } catch (_) { /* ignore */ } }
    }
    playSpecialColorBomb(): void {
        if (!this._enabled) return;
        try {
            if (this._clips['fx_colorbomb']) { this._playVol('fx_colorbomb', 1.2); return; }
            // 降级：combo1→3→5 上行三连音（拉开气势）
            if (this._isWeChat) {
                let any = false;
                [1, 3, 5].forEach((idx, i) => {
                    if (this._wxCtxCombo[idx]) {
                        any = true;
                        this.scheduleOnce(() => {
                            try {
                                this._wxCtxCombo[idx]?.stop();
                                this._wxCtxCombo[idx].volume = Math.min(1, this.volume * 1.2);
                                this._wxCtxCombo[idx]?.play();
                            } catch (_) { /* ignore */ }
                        }, i * 0.08);
                    }
                });
                if (any) return;
            } else {
                // 非微信：单 AudioSource 只能播一个，取最高 combo 模拟华丽感
                for (let i = 5; i >= 1; i--) {
                    if (this._combo[i]) { this._playComboClipVol(i, 1.2); return; }
                }
            }
            this._play('win'); // 最终兜底
        } catch (e) { try { this._play('win'); } catch (_) { /* ignore */ } }
    }

    /** 播放 combo 音效（按下标 1..5），返回是否成功播放 */
    private _playComboClip(idx: number): boolean {
        if (!this._enabled) return false; // R1: 静音守卫
        if (this._isWeChat && this._wxCtxCombo[idx]) {
            try { this._wxCtxCombo[idx].stop(); this._wxCtxCombo[idx].volume = this.volume; this._wxCtxCombo[idx].play(); } catch (e) { return false; }
            return true;
        }
        if (!this._isWeChat && this._combo[idx] && this._src) {
            this._src.clip = this._combo[idx];
            this._src.volume = this.volume;
            this._src.play();
            return true;
        }
        return false;
    }

    /** T2: 带音量加成的 combo 播放 */
    private _playComboClipVol(idx: number, volMult: number): boolean {
        if (!this._enabled) return false;
        const vol = Math.min(1, this.volume * volMult);
        if (this._isWeChat && this._wxCtxCombo[idx]) {
            try { this._wxCtxCombo[idx].stop(); this._wxCtxCombo[idx].volume = vol; this._wxCtxCombo[idx].play(); } catch (e) { return false; }
            return true;
        }
        if (!this._isWeChat && this._combo[idx] && this._src) {
            this._src.clip = this._combo[idx];
            this._src.volume = vol;
            this._src.play();
            return true;
        }
        return false;
    }

    // 连击第 n 段（n 从 1 起）：音调随 n 升高；缺档往下取最近，全缺退回 match
    playCombo(n: number): void {
        if (!this._enabled) return; // R1: 静音守卫
        const idx = Math.min(Math.max(n, 1), 5);

        if (this._isWeChat) {
            let ctx: any = null;
            for (let i = idx; i >= 1; i--) {
                if (this._wxCtxCombo[i]) { ctx = this._wxCtxCombo[i]; break; }
            }
            if (!ctx) ctx = this._wxCtxs['match'];
            if (ctx) {
                ctx.stop();
                ctx.play();
            }
        } else {
            let clip: AudioClip | null = null;
            for (let i = idx; i >= 1; i--) { if (this._combo[i]) { clip = this._combo[i]; break; } }
            if (!clip) clip = this._clips['match'];
            if (clip && this._src) {
                this._src.clip = clip;
                this._src.volume = this.volume;
                this._src.play();
            }
        }
    }

    // ── R1: 静音总开关 ─────────────────────────────

    /** 设置静音开关；关闭时停掉正在播放的音频 */
    setEnabled(on: boolean): void {
        this._enabled = (on === true);
        if (!this._enabled) {
            // 停掉正在播放的音频
            try {
                if (this._isWeChat) {
                    for (const k in this._wxCtxs) {
                        try { this._wxCtxs[k]?.stop(); } catch (e) { /* ignore */ }
                    }
                    for (let i = 1; i <= 5; i++) {
                        try { this._wxCtxCombo[i]?.stop(); } catch (e) { /* ignore */ }
                    }
                } else if (this._src) {
                    this._src.stop();
                }
            } catch (e) { /* ignore */ }
        }
        // 写入存档
        try { SaveManager.inst.setSoundEnabled(this._enabled); } catch (e) { /* ignore */ }
    }

    /** 获取当前静音开关状态 */
    getEnabled(): boolean {
        return this._enabled;
    }
}

</file>

<file path="assets/scripts/SaveManager.ts">
(563 lines)

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

</file>

<file path="assets/scripts/TileGesture.ts">
(77 lines)

import { _decorator, Component, Node, EventTouch, Vec2 } from 'cc';

const { ccclass } = _decorator;

/**
 * 方块手势组件 —— 挂在每一个方块节点上。
 * 点击 + 滑动都在这里，零坐标反算，只认本方块自己的 row / col。
 */
@ccclass('TileGesture')
export class TileGesture extends Component {

    /** 本方块行号（由 Board 在创建/移动时同步） */
    public row: number = 0;
    /** 本方块列号（由 Board 在创建/移动时同步） */
    public col: number = 0;

    /** Board 组件引用（onLoad 时通过父节点链查找） */
    private _board: any = null;

    private _startPos: Vec2 | null = null;
    private _swiped = false;

    onLoad(): void {
        // 向上查找 Board 组件：tileNode.parent = Board 节点
        this._board = this.node.parent?.getComponent('Board');
    }

    onEnable(): void {
        this.node.on(Node.EventType.TOUCH_START, this.onStart, this);
        this.node.on(Node.EventType.TOUCH_MOVE, this.onMove, this);
        this.node.on(Node.EventType.TOUCH_END, this.onEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onEnd, this);
    }

    onDisable(): void {
        this.node.off(Node.EventType.TOUCH_START, this.onStart, this);
        this.node.off(Node.EventType.TOUCH_MOVE, this.onMove, this);
        this.node.off(Node.EventType.TOUCH_END, this.onEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onEnd, this);
    }

    private onStart(e: EventTouch): void {
        this._swiped = false;
        this._startPos = e.getUILocation().clone();
        console.log('HIT', this.node.name, 'cell', this.row, this.col, 'pos', this.node.worldPosition);
    }

    private onMove(e: EventTouch): void {
        if (this._swiped || !this._startPos) return;
        const ui = e.getUILocation();
        const dx = ui.x - this._startPos.x;
        const dy = ui.y - this._startPos.y;
        if (!isFinite(dx) || !isFinite(dy)) return;

        const TH = 20;
        if (Math.abs(dx) < TH && Math.abs(dy) < TH) return;

        this._swiped = true;

        let dr = 0, dc = 0;
        if (Math.abs(dx) > Math.abs(dy)) {
            dc = dx > 0 ? 1 : -1;   // 左右
        } else {
            dr = dy > 0 ? -1 : 1;   // 上滑 dy>0 → 行号 -1
        }

        console.log('SWIPE_DIR', this.row, this.col, { dx, dy }, '->', this.row + dr, this.col + dc);
        this._board?.trySwapByDir(this.row, this.col, dr, dc);
    }

    private onEnd(): void {
        if (!this._swiped) {
            this._board?.onCellClick(this.row, this.col);
        }
        this._startPos = null;
    }
}

</file>

<file path="assets/scripts/AdManager.ts">
(196 lines)

/**
 * AdManager — 微信激励视频广告单例
 *
 * 封装 wx.createRewardedVideoAd，提供 showRewardedAd(onReward, onFail?)。
 *
 * 降级策略（保证流程永远不卡）：
 *   以下任一情况 → 直接调用 onReward 发奖，并打印 '[Ad] 降级发奖'：
 *   1. wx 不存在（浏览器预览）
 *   2. wx.createRewardedVideoAd 不可用
 *   3. 广告 onError
 *   4. adUnitId 仍为占位值 'TODO_REPLACE_广告位ID'
 */

// WeChat mini-game 全局 API（非微信环境下不存在）
declare const wx: any;

export class AdManager {
    // ── 单例 ──────────────────────────────────
    private static _instance: AdManager | null = null;

    public static getInstance(): AdManager {
        if (!AdManager._instance) {
            AdManager._instance = new AdManager();
        }
        return AdManager._instance;
    }

    // ── 广告位 ID ─────────────────────────────
    /**
     * ⚠️ 上线前替换为真实广告位 ID
     * 目前为占位值，所有广告请求将走降级逻辑（直接发奖）。
     */
    private static readonly ADUNIT_ID = 'TODO_REPLACE_广告位ID';

    // ── 广告实例 ──────────────────────────────
    private videoAd: any = null;

    // ── 当前请求的回调 ────────────────────────
    private currentOnReward: (() => void) | null = null;
    private currentOnFail: (() => void) | null = null;

    // ── 是否有进行中的广告请求（防止重复触发） ──
    private pending = false;

    // ══════════════════════════════════════════════════════════════════════════
    //  构造（私有，单例）
    // ══════════════════════════════════════════════════════════════════════════

    private constructor() {
        this.initAd();
    }

    /**
     * 初始化广告实例。
     * 仅在「微信环境 + API 可用 + adUnitId 非占位」时创建，否则保持 null（降级模式）。
     * onLoad / onError / onClose 只绑定一次，通过成员变量传递回调，避免重复触发。
     */
    private initAd(): void {
        // ── 降级检查 1：wx 不存在（浏览器预览） ──
        if (typeof wx === 'undefined') {
            console.log('[Ad] wx 不存在（浏览器预览），降级模式');
            return;
        }

        // ── 降级检查 2：createRewardedVideoAd 不可用 ──
        if (typeof wx.createRewardedVideoAd !== 'function') {
            console.log('[Ad] createRewardedVideoAd 不可用，降级模式');
            return;
        }

        // ── 降级检查 3：adUnitId 仍为占位值 ──
        if (AdManager.ADUNIT_ID === 'TODO_REPLACE_广告位ID') {
            console.log('[Ad] adUnitId 仍为占位值，降级模式');
            return;
        }

        try {
            this.videoAd = wx.createRewardedVideoAd({ adUnitId: AdManager.ADUNIT_ID });

            // 广告加载成功
            this.videoAd.onLoad(() => {
                console.log('[Ad] 广告加载成功 (onLoad)');
            });

            // 广告加载/展示失败 → 降级发奖
            this.videoAd.onError((err: any) => {
                console.error('[Ad] 广告 onError:', JSON.stringify(err));
                this.degrade();
            });

            // 广告关闭 → 判断是否完整观看
            this.videoAd.onClose((res: any) => {
                console.log('[Ad] 广告 onClose:', JSON.stringify(res));
                if (res && res.isEnded === true) {
                    // 完整看完 → 发奖
                    this.doReward();
                } else {
                    // 中途关闭 → 不发奖，走 onFail
                    this.doFail();
                }
            });

            console.log('[Ad] 广告实例创建成功，adUnitId =', AdManager.ADUNIT_ID);
        } catch (e) {
            console.error('[Ad] 创建广告实例异常:', e);
            this.videoAd = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  公开接口
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 展示激励视频广告。
     *
     * - 玩家【完整看完】(onClose res.isEnded === true) → 调用 onReward 发奖
     * - 玩家【中途关闭】→ 调用 onFail（可选）
     * - 降级情况（wx 不存在 / API 不可用 / onError / adUnitId 占位）→ 直接调用 onReward
     *
     * @param onReward 完整看完或降级时的发奖回调
     * @param onFail   中途关闭时的回调（可选，不传则什么都不做）
     */
    public showRewardedAd(onReward: () => void, onFail?: () => void): void {
        // 防止重复调用（广告展示期间用户无法再次触发）
        if (this.pending) {
            console.warn('[Ad] 已有广告请求进行中，忽略本次调用');
            return;
        }

        this.pending = true;
        this.currentOnReward = onReward;
        this.currentOnFail = onFail ?? null;

        // ── 降级检查：广告实例不存在 ──
        // （wx 不存在 / API 不可用 / adUnitId 占位 / 创建异常 都会导致 videoAd 为 null）
        if (!this.videoAd) {
            this.degrade();
            return;
        }

        // ── 展示广告 ──
        console.log('[Ad] 调用 show()');
        this.videoAd.show().catch((err: any) => {
            // show 失败（通常是广告尚未加载完成），尝试 load 后再 show
            console.warn('[Ad] show 失败，尝试 load 后重试:', JSON.stringify(err));
            this.videoAd
                .load()
                .then(() => {
                    console.log('[Ad] load 成功，再次 show');
                    return this.videoAd.show();
                })
                .catch((err2: any) => {
                    console.error('[Ad] load + show 均失败:', JSON.stringify(err2));
                    this.degrade();
                });
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  内部结算（pending 标志保证只触发一次）
    // ══════════════════════════════════════════════════════════════════════════

    /** 发奖（完整观看） */
    private doReward(): void {
        if (!this.pending) return;
        this.pending = false;
        console.log('[Ad] ✓ 发奖（完整观看）');
        const cb = this.currentOnReward;
        this.currentOnReward = null;
        this.currentOnFail = null;
        if (cb) cb();
    }

    /** 不发奖（中途关闭） */
    private doFail(): void {
        if (!this.pending) return;
        this.pending = false;
        console.log('[Ad] ✗ 未看完，不发奖');
        const cb = this.currentOnFail;
        this.currentOnReward = null;
        this.currentOnFail = null;
        if (cb) cb();
    }

    /** 降级发奖（直接调用 onReward） */
    private degrade(): void {
        if (!this.pending) return;
        this.pending = false;
        console.log('[Ad] 降级发奖');
        const cb = this.currentOnReward;
        this.currentOnReward = null;
        this.currentOnFail = null;
        if (cb) cb();
    }
}

</file>

<file path="assets/scripts/GameClubEntry.ts">
(227 lines)

/**
 * GameClubEntry — 微信游戏圈入口按钮
 *
 * 封装 wx.createGameClubButton，在主界面 / 结算页显示游戏圈入口。
 * 非微信环境（浏览器预览、wx 或 API 不存在）降级：不创建、不报错。
 *
 * 坐标系说明：
 *   wx.createGameClubButton 的 style.left/top 使用屏幕逻辑像素，
 *   需要从 Cocos 设计分辨率换算。
 */

// WeChat mini-game 全局 API（非微信环境下不存在）
declare const wx: any;

export class GameClubEntry {
    // ── 广告实例 ──────────────────────────────
    private button: any = null;

    // ── 当前可见状态 ──────────────────────────
    private _visible = false;

    // ── 布局参数（设计分辨率） ────────────────
    private canvasW: number;
    private canvasH: number;
    private topInset: number;
    private hudHeight: number;

    // ══════════════════════════════════════════════════════════════════════════
    //  构造
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @param canvasW   设计分辨率宽（如 720）
     * @param canvasH   设计分辨率高（如 1280）
     * @param topInset  顶部安全边距（设计坐标，含胶囊避让）
     * @param hudHeight HUD 高度（设计坐标）
     */
    constructor(canvasW: number, canvasH: number, topInset: number, hudHeight: number) {
        this.canvasW = canvasW;
        this.canvasH = canvasH;
        this.topInset = topInset;
        this.hudHeight = hudHeight;
        this.createButton();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  创建按钮
    // ══════════════════════════════════════════════════════════════════════════

    private createButton(): void {
        // ── 降级检查 1：wx 不存在 ──
        if (typeof wx === 'undefined') {
            console.log('[GameClub] 非微信环境，跳过');
            return;
        }

        // ── 降级检查 2：createGameClubButton 不可用 ──
        if (typeof wx.createGameClubButton !== 'function') {
            console.log('[GameClub] wx.createGameClubButton 不可用，跳过');
            return;
        }

        try {
            // ── 获取窗口尺寸（屏幕逻辑像素） ──
            let winW = 0;
            let winH = 0;
            try {
                if (wx.getWindowInfo) {
                    const info = wx.getWindowInfo();
                    winW = info.windowWidth;
                    winH = info.windowHeight;
                } else if (wx.getSystemInfoSync) {
                    const info = wx.getSystemInfoSync();
                    winW = info.windowWidth;
                    winH = info.windowHeight;
                }
            } catch (e) {
                // ignore
            }

            winW = this.safeNum(winW, 0);
            winH = this.safeNum(winH, 0);
            if (winW <= 0 || winH <= 0) {
                console.warn('[GameClub] 无法获取窗口尺寸，跳过');
                return;
            }

            // ── 设计分辨率 → 屏幕逻辑像素 换算 ──
            const designW = this.safeNum(this.canvasW, 720);
            const designH = this.safeNum(this.canvasH, 1280);
            const scaleY = winH / designH;

            // ── 按钮尺寸（屏幕逻辑像素） ──
            const btnWidth = 90;
            const btnHeight = 34;
            const gap = 10; // HUD 底部到按钮的间距（设计坐标）

            // ── 位置计算 ──
            // top: topInset + HUD_HEIGHT + gap（设计坐标）→ 换算到屏幕像素
            const designTop = this.safeNum(this.topInset, 100) + this.safeNum(this.hudHeight, 64) + gap;
            const screenTop = designTop * scaleY;

            // right: 距右边缘 16px（屏幕像素）
            const rightMargin = 16;
            const screenLeft = winW - btnWidth - rightMargin;

            // ── NaN 最终保护 ──
            if (!this.isValidNum(screenTop) || !this.isValidNum(screenLeft)) {
                console.warn('[GameClub] 坐标计算异常，跳过', { screenTop, screenLeft });
                return;
            }

            console.log(
                `[GameClub] 创建按钮: screenLeft=${screenLeft.toFixed(1)}, ` +
                `screenTop=${screenTop.toFixed(1)}, ` +
                `winW=${winW}, winH=${winH}, scaleY=${scaleY.toFixed(3)}`,
            );

            this.button = wx.createGameClubButton({
                type: 'text',
                text: '游戏圈',
                style: {
                    left: screenLeft,
                    top: screenTop,
                    width: btnWidth,
                    height: btnHeight,
                    color: '#ffffff',
                    textAlign: 'center',
                    fontSize: 15,
                    borderRadius: 17,
                    backgroundColor: '#2ecc71',
                    borderColor: '#27ae60',
                    borderWidth: 1,
                    lineHeight: btnHeight,
                },
            });

            // 按钮创建后默认可见，先隐藏（等待 GameManager 控制显隐）
            this.button.hide();
            this._visible = false;

            // 点击回调（微信会自动跳转游戏圈，这里仅做日志）
            this.button.onTap(() => {
                console.log('[GameClub] 游戏圈按钮被点击');
            });

            console.log('[GameClub] 游戏圈按钮创建成功');
        } catch (e) {
            console.error('[GameClub] 创建按钮异常:', e);
            this.button = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  公开接口
    // ══════════════════════════════════════════════════════════════════════════

    /** 显示游戏圈按钮 */
    public show(): void {
        if (!this.button) return;
        if (this._visible) return; // 已可见，不重复
        this.button.show();
        this._visible = true;
        console.log('[GameClub] show()');
    }

    /** 隐藏游戏圈按钮 */
    public hide(): void {
        if (!this.button) return;
        if (!this._visible) return; // 已隐藏，不重复
        this.button.hide();
        this._visible = false;
        console.log('[GameClub] hide()');
    }

    /** 销毁按钮 */
    public destroy(): void {
        if (this.button) {
            try {
                this.button.destroy();
            } catch (e) {
                // ignore
            }
            this.button = null;
            this._visible = false;
        }
    }

    /**
     * 窗口尺寸变化时重新定位（销毁旧按钮、用新尺寸重建）。
     * @param canvasW   新的设计分辨率宽
     * @param canvasH   新的设计分辨率高
     * @param topInset  新的顶部安全边距
     * @param hudHeight HUD 高度
     */
    public reposition(canvasW: number, canvasH: number, topInset: number, hudHeight: number): void {
        this.canvasW = canvasW;
        this.canvasH = canvasH;
        this.topInset = topInset;
        this.hudHeight = hudHeight;

        // 记录旧状态，重建后恢复
        const wasVisible = this._visible;
        this.destroy();
        this.createButton();
        if (wasVisible) {
            this.show();
        }
    }

    /** 按钮是否已成功创建 */
    public get isAvailable(): boolean {
        return this.button !== null;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  NaN 安全工具
    // ══════════════════════════════════════════════════════════════════════════

    private isValidNum(v: number): boolean {
        return typeof v === 'number' && !isNaN(v) && isFinite(v);
    }

    private safeNum(v: number, fallback: number): number {
        return this.isValidNum(v) ? v : fallback;
    }
}

</file>

<file path="assets/scripts/VibrateManager.ts">
(54 lines)

import { _decorator, Component } from 'cc';
const { ccclass, property } = _decorator;

type HapticLevel = 'light' | 'medium' | 'heavy';

@ccclass('VibrateManager')
export class VibrateManager extends Component {
    private static _inst: VibrateManager | null = null;
    public static get inst() { return VibrateManager._inst; }

    @property vibrateEnabled: boolean = true;   // 总开关（接设置里的"震动"选项，避开 Component.enabled 撞名）
    @property cooldownMs: number = 80;   // 节流：两次震动最小间隔，防连锁狂震

    private _last = 0;
    private _wx: any = (globalThis as any).wx || null;
    private _tt: any = (globalThis as any).tt || null;

    onLoad() { VibrateManager._inst = this; }
    onDestroy() { if (VibrateManager._inst === this) VibrateManager._inst = null; }

    setVibrateEnabled(on: boolean) { this.vibrateEnabled = on; }
    getVibrateEnabled() { return this.vibrateEnabled; }

    private _canFire(): boolean {
        if (!this.vibrateEnabled) return false;
        const now = Date.now();
        if (now - this._last < this.cooldownMs) return false;
        this._last = now;
        return true;
    }

    // 短震：type 控制强弱（iOS 明显，部分安卓忽略 type 只出固定短震）
    short(level: HapticLevel = 'light') {
        if (!this._canFire()) return;
        try {
            if (this._wx?.vibrateShort) this._wx.vibrateShort({ type: level });
            else if (this._tt?.vibrateShort) this._tt.vibrateShort({ type: level });
        } catch (e) { /* 真机不支持则静默，不报错 */ }
    }

    // 长震：约 400ms，用于过关/失败等重反馈
    long() {
        if (!this._canFire()) return;
        try {
            if (this._wx?.vibrateLong) this._wx.vibrateLong({});
            else if (this._tt?.vibrateLong) this._tt.vibrateLong({});
        } catch (e) { /* no-op */ }
    }

    // 语义化封装
    light()  { this.short('light'); }
    medium() { this.short('medium'); }
    heavy()  { this.short('heavy'); }
}

</file>

<file path="assets/scripts/RecorderManager.ts">
(216 lines)

/**
 * RecorderManager — 抖音录屏单例
 *
 * 封装 tt.getGameRecorderManager()，提供 start/stop/onStart/onStop。
 *
 * 降级策略（和 AdManager 一致，保证流程不卡）：
 *   以下任一情况 → 降级跳过，不报错：
 *   1. tt 不存在（浏览器 / 微信预览）
 *   2. tt.getGameRecorderManager 不可用
 *
 * Android/iOS 差异处理：
 *   stop() 后加 500ms 延迟才允许下一次 start()，
 *   否则安卓会覆盖上一段 / start 不执行。
 */

// 抖音小游戏全局 API（非抖音环境下不存在）
declare const tt: any;

type StartCallback = () => void;
type StopCallback = (videoPath: string) => void;
type ErrorCallback = (err: any) => void;

export class RecorderManager {
    // ── 单例 ──────────────────────────────────
    private static _instance: RecorderManager | null = null;

    public static getInstance(): RecorderManager {
        if (!RecorderManager._instance) {
            RecorderManager._instance = new RecorderManager();
        }
        return RecorderManager._instance;
    }

    // ── 录屏实例 ──────────────────────────────
    private recorder: any = null;

    // ── 状态 ──────────────────────────────────
    private isRecording = false;

    /** stop() 后的冷却期，防止安卓立刻 start 覆盖上一段 */
    private coolingDown = false;
    private static readonly COOLDOWN_MS = 500;

    // ── 回调 ──────────────────────────────────
    private _onStart: StartCallback | null = null;
    private _onStop: StopCallback | null = null;
    private _onError: ErrorCallback | null = null;

    // ── 最后一次录屏的 videoPath ──────────────
    private _lastVideoPath: string | null = null;

    // ══════════════════════════════════════════════════════════════════════════
    //  构造（私有，单例）
    // ══════════════════════════════════════════════════════════════════════════

    private constructor() {
        this.initRecorder();
    }

    /**
     * 初始化录屏实例。
     * 仅在「抖音环境 + API 可用」时创建，否则保持 null（降级模式）。
     */
    private initRecorder(): void {
        // ── 降级检查 1：tt 不存在 ──
        if (typeof tt === 'undefined') {
            console.log('[Recorder] tt 不存在（非抖音环境），降级跳过');
            return;
        }

        // ── 降级检查 2：getGameRecorderManager 不可用 ──
        if (typeof tt.getGameRecorderManager !== 'function') {
            console.log('[Recorder] tt.getGameRecorderManager 不可用，降级跳过');
            return;
        }

        try {
            this.recorder = tt.getGameRecorderManager();

            // 录屏开始
            this.recorder.onStart(() => {
                console.log('[Recorder] onStart — 录屏已开始');
                this.isRecording = true;
                if (this._onStart) this._onStart();
            });

            // 录屏结束（拿到 videoPath）
            this.recorder.onStop((res: any) => {
                console.log('[Recorder] onStop — 录屏已结束:', JSON.stringify(res));
                this.isRecording = false;

                const videoPath = (res && typeof res.videoPath === 'string') ? res.videoPath : '';
                if (videoPath) {
                    this._lastVideoPath = videoPath;
                    console.log('[Recorder] videoPath:', videoPath);
                }

                // 进入冷却期（安卓需要延迟才能下一次 start）
                this.startCooldown();

                if (this._onStop) this._onStop(videoPath);
            });

            // 录屏错误
            this.recorder.onError((err: any) => {
                console.error('[Recorder] onError:', JSON.stringify(err));
                this.isRecording = false;
                this.startCooldown();
                if (this._onError) this._onError(err);
            });

            console.log('[Recorder] 录屏实例创建成功');
        } catch (e) {
            console.error('[Recorder] 创建录屏实例异常:', e);
            this.recorder = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  公开接口
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 开始录屏。
     * @param duration 录屏时长（秒），抖音最大 300 秒
     */
    public start(duration: number = 300): void {
        if (!this.recorder) {
            console.log('[Recorder] 降级模式，start 跳过');
            return;
        }

        if (this.isRecording) {
            console.warn('[Recorder] 正在录屏中，忽略重复 start');
            return;
        }

        if (this.coolingDown) {
            console.warn('[Recorder] 冷却期内，忽略 start（安卓需要 500ms 间隔）');
            return;
        }

        try {
            console.log(`[Recorder] start() duration=${duration}s`);
            this.recorder.start({ duration });
        } catch (e) {
            console.error('[Recorder] start 异常:', e);
        }
    }

    /** 停止录屏，onStop 回调中拿到 videoPath */
    public stop(): void {
        if (!this.recorder) {
            console.log('[Recorder] 降级模式，stop 跳过');
            return;
        }

        if (!this.isRecording) {
            console.warn('[Recorder] 未在录屏，忽略 stop');
            return;
        }

        try {
            console.log('[Recorder] stop()');
            this.recorder.stop();
        } catch (e) {
            console.error('[Recorder] stop 异常:', e);
            this.isRecording = false;
            this.startCooldown();
        }
    }

    /**
     * 设置回调。
     * @param opts.onStart  录屏开始时调用
     * @param opts.onStop   录屏结束时调用，参数为 videoPath
     * @param opts.onError  录屏出错时调用
     */
    public on(opts: {
        onStart?: StartCallback;
        onStop?: StopCallback;
        onError?: ErrorCallback;
    }): void {
        if (opts.onStart !== undefined) this._onStart = opts.onStart;
        if (opts.onStop !== undefined) this._onStop = opts.onStop;
        if (opts.onError !== undefined) this._onError = opts.onError;
    }

    /** 是否正在录屏 */
    public get recording(): boolean {
        return this.isRecording;
    }

    /** 录屏实例是否可用 */
    public get isAvailable(): boolean {
        return this.recorder !== null;
    }

    /** 获取最后一次录屏的 videoPath */
    public get lastVideoPath(): string | null {
        return this._lastVideoPath;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  内部
    // ══════════════════════════════════════════════════════════════════════════

    /** 启动冷却计时器（安卓 stop 后立刻 start 会出问题） */
    private startCooldown(): void {
        this.coolingDown = true;
        setTimeout(() => {
            this.coolingDown = false;
            console.log('[Recorder] 冷却期结束，可以 start');
        }, RecorderManager.COOLDOWN_MS);
    }
}

</file>

