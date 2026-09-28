import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DungeonGuidePlanner, { planGuideMove } from './DungeonGuidePlanner';
import type { GuidePlanInput, GuidePosition, GuideTile } from './DungeonGuidePlanner';
import { DungeonTileType as Tile } from '../GameConstants';
import Notifier from '../notifications/Notifier';

vi.mock('../notifications/Notifier', () => ({ default: { notify: vi.fn() } }));

const point = (x: number, y: number, floor = 0): GuidePosition => ({ x, y, floor });

function input(rows: string[], guide = 'Drake', position = point(0, 0)): GuidePlanInput {
    const kinds: Record<string, Tile> = {
        '.': Tile.empty, '?': Tile.empty, C: Tile.chest, E: Tile.enemy, B: Tile.boss, L: Tile.ladder,
    };
    return {
        guide,
        position,
        tiles: rows.map((row) => [...row].map((kind): GuideTile | undefined => (kind === '#' ? undefined : {
            type: kinds[kind], visited: kind !== '?',
        }))),
        random: () => 0,
    };
}

afterEach(() => {
    DungeonGuidePlanner.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('dungeon guide next-step policy', () => {
    it('waits during blocked movement and when the current map tile is unavailable', () => {
        expect(planGuideMove({ ...input(['C']), waiting: true })).toEqual({ type: 'wait' });
        expect(planGuideMove(input(['#']))).toEqual({ type: 'wait' });
    });

    it.each(['C', 'B', 'L'])('leaves interaction with the current %s tile to the existing tick', (kind) => {
        expect(planGuideMove(input([`${kind}.`]))).toEqual({ type: 'interact' });
    });

    it('does not turn an unreachable exit into a one-step route', () => {
        expect(planGuideMove(input(['.#B']))).toEqual({ type: 'no-route' });
    });

    it('only moves one adjacent tile, including when the whole route was already visited', () => {
        const action = planGuideMove(input(['....B'], 'Drake', point(0, 0, 1)));
        expect(action).toEqual({ type: 'move', position: point(1, 0, 1), target: point(4, 0, 1) });
    });

    it('keeps Jimmy local instead of using a distant exit to choose a direction', () => {
        expect(planGuideMove(input(['...', '...', '.B.'], 'Jimmy', point(1, 1))))
            .toMatchObject({ type: 'move', position: point(1, 0) });
    });

    it('prefers adjacent unexplored tiles over already explored exits during local exploration', () => {
        expect(planGuideMove(input(['.B.', '?.?'], 'Jimmy', point(1, 1))))
            .toMatchObject({ type: 'move', position: point(0, 1) });
    });

    it('avoids immediate backtracking when an equally useful alternative is available', () => {
        const plan = { ...input(['...'], 'Jimmy', point(1, 0)), previous: point(0, 0) };
        expect(planGuideMove(plan)).toMatchObject({ type: 'move', position: point(2, 0) });
    });

    it('allows the return step required to leave a dead end', () => {
        const plan = { ...input(['..'], 'Jimmy', point(1, 0)), previous: point(0, 0) };
        expect(planGuideMove(plan)).toMatchObject({ type: 'move', position: point(0, 0) });
    });

    it('keeps randomness in visited local corridors instead of creating a deterministic loop', () => {
        const plan = input(['...'], 'Jimmy', point(1, 0));
        expect(planGuideMove(plan)).toMatchObject({ position: point(0, 0) });
        expect(planGuideMove({ ...plan, random: () => 0.999 })).toMatchObject({ position: point(2, 0) });
    });

    it('lets Timmy target a chest three steps away', () => {
        expect(planGuideMove(input(['#....C'], 'Timmy', point(2, 0))))
            .toEqual({ type: 'move', position: point(3, 0), target: point(5, 0) });
    });

    it('does not extend Timmy chest detection past three steps', () => {
        expect(planGuideMove(input(['.....C'], 'Timmy', point(1, 0))))
            .toEqual({ type: 'move', position: point(0, 0), target: point(0, 0) });
    });

    it('lets Shelly target a nearby unexplored tile without gaining chest priority', () => {
        expect(planGuideMove(input(['C...?'], 'Shelly', point(1, 0))))
            .toEqual({ type: 'move', position: point(2, 0), target: point(4, 0) });
    });

    it('does not extend Shelly exploration search past three steps', () => {
        expect(planGuideMove(input(['.....?'], 'Shelly', point(1, 0))))
            .toEqual({ type: 'move', position: point(0, 0), target: point(0, 0) });
    });

    it('preserves Angeline chest priority over a nearer unexplored tile', () => {
        expect(planGuideMove(input(['.?..C'], 'Angeline', point(2, 0))))
            .toEqual({ type: 'move', position: point(3, 0), target: point(4, 0) });
    });

    it('uses stable row-column ordering to break equal target distance ties', () => {
        expect(planGuideMove(input(['C...C'], 'Timmy', point(2, 0))))
            .toEqual({ type: 'move', position: point(1, 0), target: point(0, 0) });
    });

    it('retains a valid equally near target but drops a target that is no longer a chest', () => {
        const plan = { ...input(['C...C'], 'Timmy', point(2, 0)), target: point(4, 0) };
        expect(planGuideMove(plan)).toMatchObject({ position: point(3, 0), target: point(4, 0) });
        plan.tiles[0][4].type = Tile.empty;
        expect(planGuideMove(plan)).toMatchObject({ position: point(1, 0), target: point(0, 0) });
    });

    it('does not keep an old target over a newly nearer chest', () => {
        const plan = { ...input(['C.C..'], 'Angeline', point(3, 0)), target: point(0, 0) };
        expect(planGuideMove(plan)).toMatchObject({ position: point(2, 0), target: point(2, 0) });
    });

    it('lets Georgia take a longer enemy-free route while Drake takes the shortest route', () => {
        const plan = input(['.EB', '...'], 'Georgia');
        expect(planGuideMove(plan)).toMatchObject({ position: point(0, 1), target: point(2, 0) });
        expect(planGuideMove({ ...plan, guide: 'Drake' })).toMatchObject({ position: point(1, 0), target: point(2, 0) });
    });

    it('falls back through enemies only when Georgia has no enemy-free route', () => {
        expect(planGuideMove(input(['.EB'], 'Georgia')))
            .toEqual({ type: 'move', position: point(1, 0), target: point(2, 0) });
    });

    it('accepts an adjacent enemy-free exit as a valid Georgia route', () => {
        expect(planGuideMove(input(['.L'], 'Georgia')))
            .toEqual({ type: 'move', position: point(1, 0), target: point(1, 0) });
    });

    it('skips unreachable chest candidates instead of moving through a gap', () => {
        expect(planGuideMove(input(['C#.', '##.', '..C'], 'Angeline', point(2, 0))))
            .toEqual({ type: 'move', position: point(2, 1), target: point(2, 2) });
    });

    it('selects an adjacent fallback when a known exit is unreachable', () => {
        expect(planGuideMove(input(['..#B'], 'Drake')))
            .toEqual({ type: 'move', position: point(1, 0), target: point(1, 0) });
    });

    it('keeps Georgia on an optimal safe route across every 3 by 3 enemy layout when one exists', () => {
        // Independent distance relaxation checks all 128 placements, including barriers
        // and detours. If no safe route exists, ordinary shortest-path movement is required.
        const cells = [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2]];
        for (let mask = 0; mask < 128; mask++) {
            const rows = ['...', '...', '..B'].map((row) => [...row]);
            cells.forEach(([x, y], index) => { if (mask & (1 << index)) rows[y][x] = 'E'; });
            const distances = Array.from({ length: 3 }, () => Array(3).fill(Infinity));
            distances[2][2] = 0;
            for (let pass = 0; pass < 9; pass++) {
                for (let y = 0; y < 3; y++) {
                    for (let x = 0; x < 3; x++) {
                        if (rows[y][x] === 'E') continue;
                        [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].forEach(([nx, ny]) => {
                            if (distances[ny]?.[nx] !== undefined) distances[y][x] = Math.min(distances[y][x], distances[ny][nx] + 1);
                        });
                    }
                }
            }
            const action = planGuideMove(input(rows.map((row) => row.join('')), 'Georgia'));
            expect(action.type).toBe('move');
            if (action.type === 'move') {
                const { x, y, floor } = action.position;
                expect(x + y).toBe(1);
                expect(floor).toBe(0);
                if (Number.isFinite(distances[0][0])) {
                    expect(rows[y][x]).not.toBe('E');
                    expect(distances[y][x]).toBe(distances[0][0] - 1);
                }
            }
        }
    });
});

function runtime(plan: GuidePlanInput) {
    let position = { ...plan.position };
    const tiles = plan.tiles.map((row) => row.map((tile) => tile && ({
        type: () => tile.type, isVisited: tile.visited,
    })));
    const floors = Array.from({ length: position.floor + 1 }, () => tiles);
    const map = {
        board: vi.fn(() => floors),
        playerPosition: vi.fn(() => position),
        moveToTile: vi.fn((next: GuidePosition) => { position = next; return true; }),
    };
    const runner = { map, fighting: vi.fn(() => false), dungeonFinished: vi.fn(() => false) };
    const battle = { catching: vi.fn(() => false) };
    vi.stubGlobal('DungeonRunner', runner);
    vi.stubGlobal('DungeonBattle', battle);
    return { map, runner, battle, reposition: (next: GuidePosition) => { position = next; } };
}

describe('dungeon guide runtime adapter', () => {
    beforeEach(() => {
        DungeonGuidePlanner.reset();
        vi.clearAllMocks();
    });

    it.each(['fighting', 'catching', 'finished'])('does not read paths or move while %s', (state) => {
        const game = runtime(input(['...B']));
        if (state === 'fighting') game.runner.fighting.mockReturnValue(true);
        if (state === 'catching') game.battle.catching.mockReturnValue(true);
        if (state === 'finished') game.runner.dungeonFinished.mockReturnValue(true);
        DungeonGuidePlanner.walk('Drake');
        expect(game.map.board).not.toHaveBeenCalled();
        expect(game.map.moveToTile).not.toHaveBeenCalled();
    });

    it('moves through the original map API once and never performs interactions itself', () => {
        const game = runtime(input(['..B']));
        DungeonGuidePlanner.walk('Drake');
        expect(game.map.moveToTile).toHaveBeenCalledExactlyOnceWith(point(1, 0));
        DungeonGuidePlanner.walk('Drake');
        expect(game.map.moveToTile).toHaveBeenLastCalledWith(point(2, 0));
        DungeonGuidePlanner.walk('Drake');
        expect(game.map.moveToTile).toHaveBeenCalledTimes(2);
    });

    it('does not advance memory when the original map rejects movement', () => {
        const game = runtime(input(['....B']));
        game.map.moveToTile.mockReturnValueOnce(false);
        DungeonGuidePlanner.walk('Drake');
        DungeonGuidePlanner.walk('Drake');
        expect(game.map.moveToTile.mock.calls).toEqual([[point(1, 0)], [point(1, 0)]]);
    });

    it('clears a remembered target after external player movement', () => {
        const game = runtime(input(['C.C', '...', '...'], 'Timmy', point(2, 2)));
        DungeonGuidePlanner.walk('Timmy');
        expect(game.map.moveToTile).toHaveBeenLastCalledWith(point(2, 1));
        game.reposition(point(1, 0));
        DungeonGuidePlanner.walk('Timmy');
        expect(game.map.moveToTile).toHaveBeenLastCalledWith(point(0, 0));
    });

    it('clears a remembered target when the map instance changes', () => {
        const oldGame = runtime(input(['C..', '..C', '...'], 'Timmy', point(1, 2)));
        DungeonGuidePlanner.walk('Timmy');
        expect(oldGame.map.moveToTile).toHaveBeenLastCalledWith(point(1, 1));
        // Same current coordinates and equal targets, but a different map object.
        const nextGame = runtime(input(['...', 'C.C', '...'], 'Timmy', point(1, 1)));
        DungeonGuidePlanner.walk('Timmy');
        expect(nextGame.map.moveToTile).toHaveBeenLastCalledWith(point(0, 1));
    });

    it('clears remembered targets when the guide changes', () => {
        const plan = input(['C..', '..C', '...'], 'Timmy', point(1, 2));
        const game = runtime(plan);
        DungeonGuidePlanner.walk('Timmy');
        // At (1, 1), move the other chest to the left at equal distance.
        plan.tiles[0][0].type = Tile.empty;
        plan.tiles[1][0].type = Tile.chest;
        DungeonGuidePlanner.walk('Angeline');
        expect(game.map.moveToTile).toHaveBeenLastCalledWith(point(0, 1));
    });

    it('clears remembered targets when returning from official mode', () => {
        const plan = input(['C..', '..C', '...'], 'Timmy', point(1, 2));
        const game = runtime(plan);
        DungeonGuidePlanner.walk('Timmy');
        plan.tiles[0][0].type = Tile.empty;
        plan.tiles[1][0].type = Tile.chest;
        DungeonGuidePlanner.reset();
        DungeonGuidePlanner.walk('Timmy');
        expect(game.map.moveToTile).toHaveBeenLastCalledWith(point(0, 1));
    });

    it('uses the new floor after a ladder transition', () => {
        const game = runtime(input(['..L'], 'Drake', point(0, 0, 1)));
        DungeonGuidePlanner.walk('Drake');
        game.reposition(point(0, 0, 0));
        DungeonGuidePlanner.walk('Drake');
        expect(game.map.moveToTile).toHaveBeenLastCalledWith(point(1, 0, 0));
    });

    it('waits safely while the original lifecycle has cleared the board', () => {
        const game = runtime(input(['..B']));
        game.map.board.mockReturnValue([]);
        DungeonGuidePlanner.walk('Drake');
        expect(game.map.moveToTile).not.toHaveBeenCalled();
        expect(Notifier.notify).not.toHaveBeenCalled();
    });

    it('throttles real failures without starting a timer or changing the run', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const timer = vi.spyOn(globalThis, 'setTimeout');
        const game = runtime(input(['..B']));
        game.map.board.mockImplementation(() => { throw new Error('broken map'); });
        DungeonGuidePlanner.walk('Drake');
        DungeonGuidePlanner.walk('Drake');
        expect(Notifier.notify).toHaveBeenCalledTimes(1);
        expect(game.map.moveToTile).not.toHaveBeenCalled();
        expect(timer).not.toHaveBeenCalled();
    });
});
