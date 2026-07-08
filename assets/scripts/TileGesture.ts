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
