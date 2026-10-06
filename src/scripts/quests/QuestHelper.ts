/// <reference path="./questTypes/DefeatPokemonsQuest.ts" />
/// <reference path="./questTypes/CapturePokemonsQuest.ts" />
/// <reference path="./questTypes/CapturePokemonTypesQuest.ts" />
/// <reference path="./questTypes/ClearBattleFrontierQuest.ts" />
/// <reference path="./questTypes/GainFarmPointsQuest.ts" />
/// <reference path="./questTypes/GainMoneyQuest.ts" />
/// <reference path="./questTypes/GainTokensQuest.ts" />
/// <reference path="./questTypes/GainGemsQuest.ts" />
/// <reference path="./questTypes/HatchEggsQuest.ts" />
/// <reference path="./questTypes/MineLayersQuest.ts" />
/// <reference path="./questTypes/MineItemsQuest.ts" />
/// <reference path="./questTypes/CatchShiniesQuest.ts" />
/// <reference path="./questTypes/CatchShadowsQuest.ts" />
/// <reference path="./questTypes/DefeatGymQuest.ts" />
/// <reference path="./questTypes/DefeatDungeonQuest.ts" />
/// <reference path="./questTypes/UsePokeballQuest.ts" />
/// <reference path="./questTypes/UseOakItemQuest.ts" />
/// <reference path="./questTypes/HarvestBerriesQuest.ts" />

class QuestHelper {

    public static quests = {
        DefeatPokemonsQuest,
        CapturePokemonsQuest,
        CapturePokemonTypesQuest,
        ClearBattleFrontierQuest,
        GainFarmPointsQuest,
        GainMoneyQuest,
        GainTokensQuest,
        GainGemsQuest,
        HatchEggsQuest,
        MineLayersQuest,
        MineItemsQuest,
        CatchShiniesQuest,
        CatchShadowsQuest,
        DefeatGymQuest,
        DefeatDungeonQuest,
        UsePokeballQuest,
        UseOakItemQuest,
        HarvestBerriesQuest,
    }

    public static createQuest(questType: string, data?: any[]): Quest {
        if (!this.quests[questType]) {
            console.error(`Error: Invalid quest type - ${questType}.`);
            return;
        }
        // Creating randomly generated quest
        if (!data) {
            const QuestClass = this.quests[questType];
            return new QuestClass(...QuestClass.generateData());
        }
        return new this.quests[questType](...data);
    }

    public static availableTypes(): string[] {
        return Object.keys(this.quests).filter(type => this.quests[type].canComplete());
    }

    public static generateQuest(type: string, seed: number): Quest {
        // A row must not consume another row's random sequence (or another feature's RNG).
        const previousState = SeededRand.state;
        try {
            SeededRand.seed(seed || 1);
            return this.createQuest(type);
        } finally {
            SeededRand.state = previousState;
        }
    }

    public static highestOneShotRoute(region: GameConstants.Region): number {
        const routes = Routes.getRoutesByRegion(region).map(r => r.number);
        const first = Math.min(...routes);
        const last = Math.max(...routes);
        const attack = Math.max(1, App.game.party.calculatePokemonAttack(PokemonType.None, PokemonType.None, false, region, true, false, WeatherType.Clear));

        for (let route = last; route >= first; route--) {
            if (PokemonFactory.routeHealth(route, region) < attack) {
                return route;
            }
        }

        return 0;
    }
}
