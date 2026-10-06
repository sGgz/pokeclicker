import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

const compiled = transpileModule(readFileSync('src/scripts/towns/DreamOrbController.ts', 'utf8'), {
    compilerOptions: { target: ScriptTarget.ES2020 },
}).outputText;

function setup() {
    const obtained = new Set<string>();
    class Requirement {
        constructor(public name: string) {}
        isCompleted() { return obtained.has(this.name); }
    }
    const Controller = runInNewContext(`${compiled}\nDreamOrbController;`, {
        ko,
        ItemType: { item: 0 },
        ObtainedPokemonRequirement: Requirement,
        MultiRequirement: class {
            constructor(public requirements: Requirement[]) {}
            isCompleted() { return this.requirements.every(r => r.isCompleted()); }
        },
        TownContent: class {
            constructor(public requirements: Requirement[]) {}
            isUnlocked() { return this.requirements.every(r => r.isCompleted()); }
        },
        GameHelper: { incrementObservable: (amount: KnockoutObservable<number>) => amount(amount() + 1) },
        Rand: { fromArray: (values: unknown[]) => values[values.length - 1] },
    });
    const controller = new Controller();
    const unlock = () => ['Tornadus', 'Thundurus', 'Landorus'].forEach(name => obtained.add(name));
    return { controller, obtained, unlock, Controller };
}

describe('online Dream Orbs', () => {
    it('does not accumulate time before all three original formes are obtained', () => {
        const { controller, obtained } = setup();
        obtained.add('Tornadus');
        obtained.add('Thundurus');
        controller.update(1200);
        expect(controller.onlineTime()).toBe(0);
        expect(controller.orbs.every(orb => orb.amount() === 0)).toBe(true);
    });

    it('awards at ten minutes and preserves the remainder through saving and loading', () => {
        const { controller, unlock, Controller } = setup();
        unlock();
        controller.update(599.9);
        expect(controller.orbs[0].amount()).toBe(0);
        const restored = new Controller();
        restored.fromJSON(JSON.parse(JSON.stringify(controller.toJSON())));
        restored.update(0.1);
        expect(restored.orbs[0].amount()).toBe(1);
        restored.update(1250);
        expect(restored.orbs[0].amount()).toBe(3);
        expect(restored.onlineTime()).toBe(50);
    });

    it('selects only unlocked colors without increasing total production', () => {
        const { controller, obtained, unlock } = setup();
        unlock();
        obtained.add('Tornadus (Therian)');
        controller.update(600);
        expect(controller.orbs.map(orb => orb.amount())).toEqual([0, 1, 0, 0]);
        obtained.add('Thundurus (Therian)');
        controller.update(600);
        expect(controller.orbs.map(orb => orb.amount())).toEqual([0, 1, 1, 0]);
        obtained.add('Landorus (Therian)');
        obtained.add('Enamorus');
        controller.update(600);
        expect(controller.orbs.map(orb => orb.amount())).toEqual([0, 1, 1, 1]);
    });

    it.each([undefined, -1, null, '300', Infinity])('defaults missing or invalid saved time to zero (%s)', (onlineTime) => {
        const { controller } = setup();
        controller.fromJSON({ onlineTime, orbs: [{ color: 'Pink', amount: 5 }] });
        expect(controller.onlineTime()).toBe(0);
        expect(controller.orbs[0].amount()).toBe(5);
    });
});
