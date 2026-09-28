import { DungeonTileType } from '../GameConstants';
import Notifier from '../notifications/Notifier';
import NotificationOption from '../notifications/NotificationOption';

export interface GuidePosition {
    x: number;
    y: number;
    floor: number;
}

export interface GuideTile {
    type: DungeonTileType;
    visited: boolean;
}

export interface GuidePlanInput {
    guide: string;
    tiles: (GuideTile | undefined)[][];
    position: GuidePosition;
    previous?: GuidePosition;
    target?: GuidePosition;
    waiting?: boolean;
    random?: () => number;
}

export type GuideAction =
    | { type: 'move'; position: GuidePosition; target: GuidePosition }
    | { type: 'interact' | 'wait' | 'no-route' };

interface SearchNode {
    position: GuidePosition;
    distance: number;
    previous?: SearchNode;
}

type Route = { type: 'move'; next: GuidePosition } | { type: 'arrived' | 'unreachable' };

function positionKey(position: GuidePosition): string {
    return `${position.x},${position.y}`;
}

function samePosition(left?: GuidePosition, right?: GuidePosition): boolean {
    return !!left && !!right && left.x === right.x && left.y === right.y && left.floor === right.floor;
}

function neighbors(tiles: GuidePlanInput['tiles'], position: GuidePosition): GuidePosition[] {
    // Stable row/column order also makes shortest-path ties reproducible.
    return [
        { ...position, y: position.y - 1 },
        { ...position, x: position.x - 1 },
        { ...position, x: position.x + 1 },
        { ...position, y: position.y + 1 },
    ].filter((point) => !!tiles[point.y]?.[point.x]);
}

/** One breadth-first search supplies every candidate's distance and predecessor. */
function searchFloor(input: GuidePlanInput, avoidEnemies = false, maxDistance = Infinity): Map<string, SearchNode> {
    const start: SearchNode = { position: input.position, distance: 0 };
    const queue = [start];
    const visited = new Map<string, SearchNode>([[positionKey(input.position), start]]);
    for (let index = 0; index < queue.length; index++) {
        const node = queue[index];
        if (node.distance >= maxDistance) {
            continue;
        }
        neighbors(input.tiles, node.position).forEach((position) => {
            const key = positionKey(position);
            if (visited.has(key) || (avoidEnemies && input.tiles[position.y][position.x].type === DungeonTileType.enemy)) {
                return;
            }
            const next = { position, distance: node.distance + 1, previous: node };
            visited.set(key, next);
            queue.push(next);
        });
    }
    return visited;
}

function routeTo(search: Map<string, SearchNode>, target: GuidePosition): Route {
    let node = search.get(positionKey(target));
    if (!node) {
        return { type: 'unreachable' };
    }
    if (!node.previous) {
        return { type: 'arrived' };
    }
    while (node.previous.previous) {
        node = node.previous;
    }
    return { type: 'move', next: node.position };
}

function nearestTarget(input: GuidePlanInput, search: Map<string, SearchNode>, predicate: (tile: GuideTile) => boolean): GuidePosition | undefined {
    let nearest: SearchNode | undefined;
    search.forEach((node) => {
        if (!predicate(input.tiles[node.position.y][node.position.x])) {
            return;
        }
        const tied = node.distance === nearest?.distance;
        const preferred = samePosition(node.position, input.target);
        const existingPreferred = samePosition(nearest?.position, input.target);
        const earlier = nearest && (node.position.y < nearest.position.y || (node.position.y === nearest.position.y && node.position.x < nearest.position.x));
        if (!nearest || node.distance < nearest.distance || (tied && (preferred || (!existingPreferred && earlier)))) {
            nearest = node;
        }
    });
    return nearest?.position;
}

function moveToward(search: Map<string, SearchNode>, target: GuidePosition): GuideAction {
    const route = routeTo(search, target);
    if (route.type === 'move') {
        return { type: 'move', position: route.next, target };
    }
    return { type: route.type === 'arrived' ? 'interact' : 'no-route' };
}

function exploreAdjacent(input: GuidePlanInput): GuideAction {
    let candidates = neighbors(input.tiles, input.position);
    const unexplored = candidates.filter((point) => !input.tiles[point.y][point.x].visited);
    if (unexplored.length) {
        candidates = unexplored;
    }
    const forward = candidates.filter((point) => !samePosition(point, input.previous));
    if (forward.length) {
        candidates = forward;
    }
    if (!candidates.length) {
        return { type: 'no-route' };
    }
    // Keep weighted randomness for local exploration: deterministic ties can loop forever
    // through visited corridors. This reads adjacent tile kinds, never hidden loot data.
    const weights = candidates.map((point) => {
        switch (input.tiles[point.y][point.x].type) {
            case DungeonTileType.boss:
            case DungeonTileType.ladder: return 4.5;
            case DungeonTileType.chest: return 2.5;
            case DungeonTileType.enemy: return 1.5;
            default: return 0.5;
        }
    });
    let choice = (input.random ?? Math.random)() * weights.reduce((sum, weight) => sum + weight, 0);
    const selected = candidates.find((_, index) => {
        choice -= weights[index];
        return choice < 0;
    }) ?? candidates[candidates.length - 1];
    return { type: 'move', position: selected, target: selected };
}

/** Pure next-step decision. Interactions and the run lifecycle stay with DungeonGuide.tick. */
export function planGuideMove(input: GuidePlanInput): GuideAction {
    const { position, tiles, guide } = input;
    const current = tiles[position.y]?.[position.x];
    if (input.waiting || !current) {
        return { type: 'wait' };
    }
    if ([DungeonTileType.chest, DungeonTileType.boss, DungeonTileType.ladder].includes(current.type)) {
        return { type: 'interact' };
    }
    if (guide === 'Jimmy') {
        return exploreAdjacent(input);
    }
    if (guide === 'Georgia' || guide === 'Drake') {
        // Preserve the original exit knowledge and boss-before-ladder preference.
        const candidates: { position: GuidePosition; type: DungeonTileType }[] = [];
        tiles.forEach((row, y) => row.forEach((tile, x) => {
            if (tile && [DungeonTileType.boss, DungeonTileType.ladder].includes(tile.type)) {
                candidates.push({ position: { x, y, floor: position.floor }, type: tile.type });
            }
        }));
        const target = (candidates.find((tile) => tile.type === DungeonTileType.boss) ?? candidates[0])?.position;
        if (target) {
            let search = searchFloor(input, guide === 'Georgia');
            // An adjacent reachable exit is a valid path, not an avoidance failure.
            if (guide === 'Georgia' && routeTo(search, target).type === 'unreachable') {
                search = searchFloor(input);
            }
            const action = moveToward(search, target);
            if (action.type !== 'no-route') {
                return action;
            }
        }
        return exploreAdjacent(input);
    }
    if (guide === 'Timmy' || guide === 'Shelly' || guide === 'Angeline') {
        const search = searchFloor(input, false, guide === 'Angeline' ? Infinity : 3);
        const chest = guide !== 'Shelly'
            ? nearestTarget(input, search, (tile) => tile.type === DungeonTileType.chest) : undefined;
        const target = chest ?? (guide !== 'Timmy' ? nearestTarget(input, search, (tile) => !tile.visited) : undefined);
        if (target) {
            return moveToward(search, target);
        }
    }
    return exploreAdjacent(input);
}

interface RuntimeTile {
    isVisited: boolean;
    type(): DungeonTileType;
}

interface RuntimeMap {
    board(): RuntimeTile[][][];
    playerPosition(): GuidePosition;
    moveToTile(position: GuidePosition): boolean;
}

interface RuntimeRunner {
    map?: RuntimeMap;
    fighting(): boolean;
    dungeonFinished(): boolean;
}
declare const DungeonBattle: { catching(): boolean };

interface PlannerMemory {
    map: RuntimeMap;
    guide: string;
    expected: GuidePosition;
    previous?: GuidePosition;
    target?: GuidePosition;
}

export default class DungeonGuidePlanner {
    private static memory?: PlannerMemory;
    private static lastWarningAt = -Infinity;

    public static reset(): void {
        this.memory = undefined;
    }

    public static walk(guide: string): void {
        try {
            this.moveOnce(guide);
        } catch (error) {
            this.reset();
            if (Date.now() - this.lastWarningAt >= 30000) {
                this.lastWarningAt = Date.now();
                console.error('Dungeon guide pathfinding failed:', error);
                Notifier.notify({
                    title: '地牢助手寻路',
                    message: '本次寻路未能完成，助手会在下一次行动时重试；当前地牢仍按原规则结算。',
                    type: NotificationOption.warning,
                });
            }
        }
    }

    private static moveOnce(guide: string): void {
        if (typeof DungeonRunner === 'undefined' || typeof DungeonBattle === 'undefined') {
            this.reset();
            return;
        }
        const runner = DungeonRunner as unknown as RuntimeRunner;
        const { map } = runner;
        if (!map || runner.dungeonFinished()) {
            this.reset();
            return;
        }
        if (runner.fighting() || DungeonBattle.catching()) {
            return;
        }
        const position = map.playerPosition();
        const floor = map.board()?.[position.floor];
        if (!floor?.[position.y]?.[position.x]) {
            this.reset();
            return;
        }
        const memory = this.memory;
        if (!memory || memory.map !== map || memory.guide !== guide || !samePosition(memory.expected, position)) {
            this.memory = { map, guide, expected: { ...position } };
        }
        const action = planGuideMove({
            guide,
            position,
            tiles: floor.map((row) => row.map((tile) => tile && ({ type: tile.type(), visited: tile.isVisited }))),
            previous: this.memory.previous,
            target: this.memory.target,
        });
        if (action.type !== 'move') {
            this.memory.target = undefined;
            return;
        }
        const next = action.position;
        // Never use the map's visited-tile shortcut to teleport to a distant target.
        if (next.floor !== position.floor || !floor[next.y]?.[next.x] || Math.abs(next.x - position.x) + Math.abs(next.y - position.y) !== 1) {
            throw new Error('Dungeon guide planned a non-adjacent step');
        }
        if (map.moveToTile(next)) {
            this.memory = { map, guide, expected: { ...next }, previous: { ...position }, target: action.target };
        }
    }
}
