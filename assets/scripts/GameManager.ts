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
import { Board, BoardCallbacks } from './Board';
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
type GoalType = 'score' | 'collect' | 'special';

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
        { level: 1,  chapter: 1, isBoss: false, goalType: 'score',   targetScore: 600,  moves: 25, colors: 5 },
        { level: 2,  chapter: 1, isBoss: false, goalType: 'score',   targetScore: 1000, moves: 22, colors: 5 },
        { level: 3,  chapter: 1, isBoss: false, goalType: 'collect', goalColor: 'pink', goalCount: 15, moves: 22, colors: 5 },
        { level: 4,  chapter: 1, isBoss: false, goalType: 'score',   targetScore: 1500, moves: 20, colors: 5 },
        { level: 5,  chapter: 1, isBoss: true,  goalType: 'score',   targetScore: 2200, moves: 18, colors: 5 },
        // —— 第 2 章：进阶（6 色）——
        { level: 6,  chapter: 2, isBoss: false, goalType: 'score',   targetScore: 1600, moves: 24, colors: 6 },
        { level: 7,  chapter: 2, isBoss: false, goalType: 'collect', goalColor: ['blue', 'green'], goalCount: [20, 20], moves: 22, colors: 6 },
        { level: 8,  chapter: 2, isBoss: false, goalType: 'score',   targetScore: 2800, moves: 20, colors: 6 },
        { level: 9,  chapter: 2, isBoss: false, goalType: 'special', specialCount: 3, moves: 20, colors: 6 },
        { level: 10, chapter: 2, isBoss: true,  goalType: 'score',   targetScore: 3600, moves: 18, colors: 6 },
        // —— 第 3 章：挑战（6 色）——
        { level: 11, chapter: 3, isBoss: false, goalType: 'score',   targetScore: 2600, moves: 24, colors: 6 },
        { level: 12, chapter: 3, isBoss: false, goalType: 'collect', goalColor: ['mon_purple', 'orange'], goalCount: [25, 25], moves: 20, colors: 6 },
        { level: 13, chapter: 3, isBoss: false, goalType: 'special', specialCount: 5, moves: 20, colors: 6 },
        { level: 14, chapter: 3, isBoss: false, goalType: 'score',   targetScore: 3800, moves: 18, colors: 6 },
        { level: 15, chapter: 3, isBoss: true,  goalType: 'score',   targetScore: 4800, moves: 18, colors: 6 },
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

    // ── 图鉴页（E3） ─────────────────────────────
    private collectionPanel: Node | null = null;
    private collectionCompletionLabel: Label | null = null;
    private collectionCells: { emojiLabel: Label; starLabel: Label; countLabel: Label; bgNode: Node; upgradeBtn: Node }[] = [];

    // ── 首页层（F0） ─────────────────────────────
    private homePanel: Node | null = null;
    private homeBgSprite: Sprite | null = null;

    private stepsPanel: Node | null = null;
    private hidingPanels: Set<Node> = new Set();
    private chapterCard: Node | null = null;
    private chapterTitleLabel: Label | null = null;
    private chapterSubtitleLabel: Label | null = null;
    private chapterBossLabel: Label | null = null;

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
            } as BoardCallbacks);
        }

        this.createAllUI();
        this.createChapterCard();

        // 监听窗口尺寸变化（微信 onResize / 浏览器 resize）
        this.setupResizeListener();

        // 初始化录屏回调
        this.setupRecorder();
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
        // F0: 启动先显示首页（不再直接进关卡选择页）
        this.showHomePanel();

        // ===== TEMP DEBUG (收藏系统真机验收用·上线前删) =====
        // 待偿债务：collectionDebug 调试入口，上线前必须删除
        this._setupCollectionDebug();
        // ===== END TEMP DEBUG =====
    }

    // ===== TEMP DEBUG (收藏系统真机验收用·上线前删) =====
    /** 待偿债务：挂全局调试对象，上线前删 */
    private _setupCollectionDebug(): void {
        const g = globalThis as any;
        if (!g) return; // 非 browser/wx 环境安全跳过

        g.collectionDebug = {
            /** TEMP: 给扭蛋币，测抽卡 */
            grantCoins: (n: number = 500): void => {
                const safeN = (typeof n === 'number' && !isNaN(n) && isFinite(n)) ? Math.floor(n) : 500;
                SaveManager.inst.addCoins(safeN);
                const coins = SaveManager.inst.getCoins();
                console.log(`[collectionDebug] grantCoins(${safeN}) → 余额=${coins}`);
            },

            /** TEMP: 给指定怪物 count 次，测升星 */
            grantMonster: (id: number, count: number = 3): void => {
                const safeId = (typeof id === 'number' && !isNaN(id) && isFinite(id) && id >= 0 && id <= 5) ? Math.floor(id) : 0;
                const safeCount = (typeof count === 'number' && !isNaN(count) && isFinite(count)) ? Math.floor(count) : 3;
                for (let i = 0; i < safeCount; i++) {
                    SaveManager.inst.addMonster(safeId);
                }
                const rec = SaveManager.inst.getMonster(safeId);
                const coins = SaveManager.inst.getCoins();
                console.log(`[collectionDebug] grantMonster(id=${safeId}, count=${safeCount}) → count=${rec.count} star=${rec.star} | coins=${coins}`);
            },

            /** TEMP: 清空收藏 + 币归零，测首抽 NEW */
            clearCollection: (): void => {
                SaveManager.inst.resetAll();
                const coins = SaveManager.inst.getCoins();
                console.log(`[collectionDebug] clearCollection() → 存档已清空 | coins=${coins}`);
                for (let i = 0; i < 6; i++) {
                    const rec = SaveManager.inst.getMonster(i);
                    console.log(`  monId=${i}: count=${rec.count} star=${rec.star}`);
                }
            },
        };

        console.log('[collectionDebug] ★ 调试入口已挂载: collectionDebug.grantCoins(500) / .grantMonster(0,3) / .clearCollection()');
    }
    // ===== END TEMP DEBUG =====

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

        this.hidePanel(this.resultPanel);
        this.hidePanel(this.stepsPanel);

        // 游戏进行中 → 隐藏游戏圈按钮
        this.gameClubEntry?.hide();

        this.board?.setLevel(levelIndex);  // C0: 设置关卡号（L1=0 触发手势引导）
        this.board?.resetBoard(config.colors);
        // setBusy(false) 移到章节卡逻辑末尾（避免过场卡期间棋盘可交互）

        this.updateHUD();

        // Fix 1.1: 延迟打印 HUD 诊断（确保 updateHUD 已设好 string）
        this.scheduleOnce(() => {
            this.dumpHudTree();
            this.layoutBoard();
        }, 0.1);

        // 开始录屏（抖音环境才生效，非抖音降级跳过）
        RecorderManager.getInstance().start(300);

        console.log(`[GameManager] ── L${config.level} (第${config.chapter}章${config.isBoss ? '·Boss' : ''}) 开始 | 目标=${config.goalType} | ${config.moves} 步 | ${config.colors} 色 ──`);

        // ★ 章节过场卡：进入新章首关时弹一次
        const newChapter = this.safeNum(config.chapter, 1);
        if (this.lastChapter !== 0 && this.lastChapter !== newChapter) {
            this.showChapterCard(newChapter, config.isBoss);
        } else {
            // 首次进入或同章切关：直接开始
            this.lastChapter = newChapter;
            this.board?.setBusy(false);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Board 回调
    // ══════════════════════════════════════════════════════════════════════════

    private onValidSwap(): void {
        this.currentSteps = Math.max(0, this.currentSteps - 1);
        this.updateHUD();
        console.log(`[GameManager] 有效交换，剩余步数: ${this.currentSteps}`);
    }

    private onScoreChange(score: number): void {
        this.currentScore = score;
        this.updateHUD();
        // ★ 分数跳动 punch scale (1→1.25→1, 0.15s)
        if (this.scoreLabel) {
            Tween.stopAllByTarget(this.scoreLabel.node);
            this.scoreLabel.node.setScale(1, 1, 1);
            tween(this.scoreLabel.node)
                .to(0.075, { scale: new Vec3(1.25, 1.25, 1) })
                .to(0.075, { scale: new Vec3(1, 1, 1) })
                .start();
        }
    }

    private onChainComplete(): void {
        const config = this.levelConfigs[this.currentLevel];

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
        const subtitles = ['', '初识', '进阶', '终章'];
        const idx = this.safeNum(chapter, 1);
        return subtitles[idx] ?? `第${idx}章`;
    }

    /** 根据 goalType 生成 HUD 中间段的目标进度文本 */
    private getGoalHudText(cfg: LevelConfig): string {
        switch (cfg.goalType) {
            case 'score':
                return `🎯 ${this.currentScore}/${this.safeNum(cfg.targetScore, 0)}`;
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
            default:
                return `🎯 ${this.currentScore}`;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  弹层 — 结算
    // ══════════════════════════════════════════════════════════════════════════

    private showResultPanel(isWin: boolean): void {
        if (!this.resultPanel) return;

        // 停止录屏（onStop 会拿到 videoPath）
        RecorderManager.getInstance().stop();

        this.showPanel(this.resultPanel);

        // 结算页 → 显示游戏圈按钮
        this.gameClubEntry?.show();

        this.resultTitle!.string = isWin ? '过关 🎉' : '再试一次 😵';
        this.resultTitle!.color = isWin ? this.COLOR_TITLE_WIN.clone() : this.COLOR_TITLE_LOSE.clone();
        this.resultScore!.string = this.getResultScoreText(this.levelConfigs[this.currentLevel]);

        // ★ Boss 关过关：额外庆祝
        const config = this.levelConfigs[this.currentLevel];
        if (isWin && config.isBoss) {
            const chapter = this.safeNum(config.chapter, 1);
            this.resultScore!.string = `第${chapter}章 完成！\n` + this.getResultScoreText(config);
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
            AudioManager.inst?.playWin();
            VibrateManager.inst?.long();
            // Boss 关额外震动
            if (config.isBoss) VibrateManager.inst?.heavy();
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
        } else {
            AudioManager.inst?.playLose();
            VibrateManager.inst?.long();
            // 失败不发币，隐藏提示
            this.lastCoinReward = 0;
            if (this.resultCoinLabel) {
                this.resultCoinLabel.node.active = false;
            }
        }
        console.log(`[GameManager] 结算: ${isWin ? '过关' : '失败'} | 得分 ${this.currentScore}`);
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
        this.showPanel(this.stepsPanel);
        // 步数耗尽弹层 → 显示游戏圈按钮
        this.gameClubEntry?.show();
        // 停止录屏
        RecorderManager.getInstance().stop();
        console.log('[GameManager] 步数耗尽弹层');
    }

    private onStepsAdClick(): void {
        AdManager.getInstance().showRewardedAd(
            () => {
                // ✓ 发奖：+5 步、关闭弹层、继续本关
                this.currentSteps += 5;
                this.updateHUD();
                this.hidePanel(this.stepsPanel);
                this.board?.setBusy(false);
                // 回到游戏 → 隐藏游戏圈按钮
                this.gameClubEntry?.hide();
                console.log(`[GameManager] 广告奖励 — +5 步！当前步数: ${this.currentSteps}`);
            },
            () => {
                // ✗ 未看完：弹层保持，用户可再试或放弃
                console.log('[GameManager] 广告未看完，步数弹层保持');
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

        // ── 1. 背景：压暗淡紫粉竖向渐变 + 暗角 + 柔点装饰 ──
        const bgNode = new Node('Background');
        bgNode.parent = canvas;
        bgNode.setSiblingIndex(0); // 放最底
        const bgUT = bgNode.addComponent(UITransform);
        const bgW = this.safeNum(this.canvasW, 720);
        const bgH = this.safeNum(this.canvasH, 1280);
        bgUT.setContentSize(bgW, bgH);

        const bgG = bgNode.addComponent(Graphics);
        // 竖向渐变：顶部 #CDB8CE → 中间 #E4D2E2 → 底部 #CDB8CE（3段近似）
        const segH = bgH / 3;
        bgG.fillColor = new Color(0xCD, 0xB8, 0xCE);
        bgG.rect(-bgW / 2, bgH / 6, bgW, segH);
        bgG.fill();
        bgG.fillColor = new Color(0xE4, 0xD2, 0xE2);
        bgG.rect(-bgW / 2, -bgH / 6, bgW, segH);
        bgG.fill();
        bgG.fillColor = new Color(0xCD, 0xB8, 0xCE);
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
        this.createResultPanel();
        this.createStepsPanel();
        this.createLevelSelectPanel();
        this.createGachaPanel();
        this.createCollectionPanel();
        this.createHomePanel();
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

        // 诊断：打印完整 HUD 结构
        this.dumpHudTree();
    }

    /** 递归打印 HUD 节点树（根节点 + 所有子节点 + Label 详情） */
    private dumpHudTree(): void {
        if (!this.hudNode || !this.hudNode.isValid) {
            console.log('[HUD-DUMP] hudNode is null or destroyed');
            return;
        }

        const hud = this.hudNode;
        const hudUT = hud.getComponent(UITransform);
        const hudWP = hud.worldPosition;

        // 1. 打印 HUD 根节点
        console.log(
            `[HUD-DUMP] Root: name=${hud.name} active=${hud.active} ` +
            `size=(${this.safeNum(hudUT?.width, -1).toFixed(0)}×${this.safeNum(hudUT?.height, -1).toFixed(0)}) ` +
            `anchor=(${hudUT?.anchorX ?? '?'},${hudUT?.anchorY ?? '?'}) ` +
            `worldPos=(${hudWP.x.toFixed(1)},${hudWP.y.toFixed(1)}) ` +
            `layer=${hud.layer}`,
        );

        // 打印 boundingBox
        if (hudUT) {
            const bb = hudUT.getBoundingBoxToWorld();
            console.log(
                `[HUD-DUMP] Root BBox: x=${bb.x.toFixed(1)} y=${bb.y.toFixed(1)} ` +
                `w=${bb.width.toFixed(1)} h=${bb.height.toFixed(1)}`,
            );
        }

        // 2. 递归打印所有子节点
        const childCount = hud.children.length;
        console.log(`[HUD-DUMP] Children count: ${childCount}`);
        for (let i = 0; i < childCount; i++) {
            const child = hud.children[i];
            const childUT = child.getComponent(UITransform);
            const childWP = child.worldPosition;
            const label = child.getComponent(Label);
            const parentName = child.parent?.name ?? '(none)';

            if (label) {
                console.log(
                    `[HUD-DUMP]   [${i}] name=${child.name} active=${child.active} ` +
                    `parent=${parentName} ` +
                    `Label: string="${label.string}" ` +
                    `color=(${label.color.r},${label.color.g},${label.color.b},${label.color.a}) ` +
                    `fontSize=${label.fontSize} ` +
                    `overflow=${label.overflow} ` +
                    `size=(${this.safeNum(childUT?.width, -1).toFixed(0)}×${this.safeNum(childUT?.height, -1).toFixed(0)}) ` +
                    `localPos=(${child.position.x.toFixed(1)},${child.position.y.toFixed(1)}) ` +
                    `worldPos=(${childWP.x.toFixed(1)},${childWP.y.toFixed(1)}) ` +
                    `layer=${child.layer}`,
                );
            } else {
                console.log(
                    `[HUD-DUMP]   [${i}] name=${child.name} active=${child.active} ` +
                    `parent=${parentName} (no Label) ` +
                    `size=(${this.safeNum(childUT?.width, -1).toFixed(0)}×${this.safeNum(childUT?.height, -1).toFixed(0)}) ` +
                    `worldPos=(${childWP.x.toFixed(1)},${childWP.y.toFixed(1)}) ` +
                    `layer=${child.layer}`,
                );
            }
        }
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

        // Card 尺寸（NaN 兜底）
        const cardW = 560, cardH = 780;

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

        // Card：奶白圆角卡片 + 淡紫描边
        const card = new Node('Card');
        card.parent = this.resultPanel;
        const cardUT = card.addComponent(UITransform);
        cardUT.setContentSize(cardW, cardH);
        this.addWidget(card, { hCenter: 0, vCenter: 40 });

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
        cardLayout.spacingY = 24;
        cardLayout.paddingTop = 44;
        cardLayout.paddingBottom = 44;
        cardLayout.horizontalDirection = Layout.HorizontalDirection.CENTER;
        cardLayout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
        cardLayout.resizeMode = Layout.ResizeMode.NONE;

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

        // 广告按钮（暖金高亮实心）
        this.resultAdBtn = this.createRoundButton(card, 'AdBtn', '▶  看广告·得分翻倍',
            this.COLOR_BTN_AD, 440, 94, () => this.onResultAdClick());
        this.resultAdLabel = this.resultAdBtn.getChildByName('Label')!.getComponent(Label)!;

        // 分享按钮
        this.resultShareBtn = this.createRoundButton(card, 'ShareBtn', '录屏不可用',
            this.COLOR_BTN_GIVEUP, 440, 94, () => this.onShareRecordClick());
        this.resultShareLabel = this.resultShareBtn.getChildByName('Label')!.getComponent(Label)!;
        this.resultShareBtn.getComponent(Button)!.interactable = false;

        // 主按钮（下一关/重玩 = 主色实心）
        this.resultNextBtn = this.createRoundButton(card, 'NextBtn', '下一关',
            this.COLOR_BTN_PRIMARY, 440, 94, () => this.onResultNextClick());
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
        this.createRoundButton(card, 'AdBtn', '▶  看广告 +5 步',
            this.COLOR_BTN_AD, 440, 94, () => this.onStepsAdClick());

        // 放弃按钮（幽灵按钮：透明底 + 描边）
        this.createRoundButton(card, 'GiveUpBtn', '放弃·去结算',
            this.COLOR_BTN_GIVEUP, 440, 94, () => this.onStepsGiveUpClick(),
            { ghost: true });

        this.stepsPanel.active = false;
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

        // Card 尺寸（加高以容纳全部内容 + 底部入口按钮）
        const cardW = this.safeNum(640, 640);
        const cardH = this.safeNum(840, 840);

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

        // 3 章分组
        const chapterNames = ['', '第 1 章 · 入门', '第 2 章 · 进阶', '第 3 章 · 挑战'];
        const btnSize = 100;
        const gap = 15;

        for (let ch = 1; ch <= 3; ch++) {
            // 章节标题
            const chTitle = this.createLabel(card, `Ch${ch}Title`, chapterNames[ch], 30, this.COLOR_HUD_TEXT);
            chTitle.isBold = true;
            const chTitleW = this.safeNum(cardW - 80, 560);
            chTitle.node.getComponent(UITransform)!.setContentSize(chTitleW, 40);
            chTitle.overflow = Label.Overflow.SHRINK;
            chTitle.enableWrapText = false;

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

        this.levelSelectPanel.active = false;
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
            bossNode.addComponent(UITransform).setContentSize(size, 18);
            const bossLabel = bossNode.addComponent(Label);
            bossLabel.string = '⭐BOSS';
            bossLabel.fontSize = 13;
            bossLabel.lineHeight = 16;
            bossLabel.color = this.COLOR_CHAPTER_GOLD.clone();
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
                btn.bg.fillColor = this.COLOR_BTN_AD.clone(); // 金色高亮
                btn.bg.strokeColor = new Color(0, 0, 0, 40);
            } else {
                // 已通关：紫色
                btn.bg.fillColor = this.COLOR_BTN_PRIMARY.clone();
                btn.bg.strokeColor = new Color(0, 0, 0, 40);
            }
            btn.bg.lineWidth = 2;
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
        }

        console.log(`[GameManager] 关卡选择页已刷新: maxUnlocked=${maxUnlocked}`);
    }

    /** 显示关卡选择页（刷新状态 + 弹出动画） */
    private showLevelSelectPanel(): void {
        if (!this.levelSelectPanel) return;
        this.refreshLevelSelectStates();
        this.showPanel(this.levelSelectPanel);
        // 选择页全屏覆盖 → 隐藏游戏圈按钮
        this.gameClubEntry?.hide();
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
        sloganLabel.string = '边消边收集软萌公仔';
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
        this.gameClubEntry?.hide();
        console.log('[GameManager] 显示首页');
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

        const emoji = COLOR_EMOJI_MAP[monId] ?? '?';
        this.gachaResultEmoji.string = emoji;

        // Rarity label color
        let rarityColor: Color;
        switch (rarity) {
            case 'SSR': rarityColor = this.COLOR_RARITY_SSR.clone(); break;
            case 'SR': rarityColor = this.COLOR_RARITY_SR.clone(); break;
            default: rarityColor = this.COLOR_RARITY_R.clone(); break;
        }
        this.gachaResultRarity.string = rarity;
        this.gachaResultRarity.color = rarityColor;

        // NEW!
        this.gachaResultNew.node.active = isNew;

        // Show + animate (scale 0→1.2→1)
        this.gachaResultNode.active = true;
        this.gachaResultNode.setScale(0, 0, 1);
        Tween.stopAllByTarget(this.gachaResultNode);
        tween(this.gachaResultNode)
            .to(0.25, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'backOut' })
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

        // Card
        const cardW = 640, cardH = 860;
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
        const backBottomMargin = 32; // 返回按钮距卡片底部 ≥30px

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

        // ── 返回按钮：用 getBoundingBoxToWorld() 实测卡片底边定位 ──
        const backBtn = this.createRoundButton(card, 'BackBtn', '返回',
            this.COLOR_BTN_GIVEUP, 440, backH, () => this.onCollectionBack(),
            { ghost: true });

        // 强制更新世界变换，实测卡片 BBox
        card.updateWorldTransform();
        const cardBox = card.getComponent(UITransform)!.getBoundingBoxToWorld();
        const actualCardH = this.safeNum(cardBox.height, cardH);
        // 卡片底边在本地坐标系（anchor 0.5,0.5）的 Y = -actualCardH/2
        const cardLocalBottomY = this.safeNum(-actualCardH / 2, -400);
        // 返回按钮中心 Y = 卡片底边 + 底部留白 + 按钮高度/2
        const backBtnY = this.safeNum(cardLocalBottomY + backBottomMargin + backH / 2, -300);
        backBtn.setPosition(0, backBtnY, 0);

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

        // 音效 + 震动（复用 win）
        AudioManager.inst?.playWin();
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

        // Button SCALE 反馈
        const button = node.addComponent(Button);
        button.transition = Button.Transition.SCALE;
        button.duration = 0.1;
        button.zoomScale = 0.92;
        button.node.on(Button.EventType.CLICK, callback, this);

        return node;
    }

    private showPanel(panel: Node | null): void {
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
}
