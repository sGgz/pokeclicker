/// <reference path="../declarations/TemporaryScriptTypes.d.ts" />
///<reference path="../declarations/Sortable.d.ts"/>

class Save {

    // Process new day events as soon as possible after loading a file.
    static counter = GameConstants.SAVE_TICK - GameConstants.TICK_TIME;
    static key = '';

    public static store(player: Player, showNotification = false) {
        if (!CloudSave.canSave()) {
            return;
        }
        const keys = ['player', 'save', 'settings'].map(prefix => prefix + Save.key);
        const previous = keys.map(key => localStorage.getItem(key));
        const snapshot: [string, string, string] = [
            JSON.stringify(player),
            JSON.stringify(this.getSaveObject()),
            JSON.stringify(Settings.toJSON()),
        ];
        try {
            keys.forEach((key, index) => localStorage.setItem(key, snapshot[index]));
        } catch (error) {
            try {
                keys.forEach((key, index) => previous[index] === null
                    ? localStorage.removeItem(key) : localStorage.setItem(key, previous[index]));
            } catch {}
            CloudSave.blockUploads('本地保存失败，可能是浏览器空间不足。');
            throw error;
        }
        CloudSave.afterLocalSave(Save.key, snapshot);

        this.counter = 0;
        if (showNotification) {
            Notifier.notify({ message: 'Game Saved!'});
        }
        //console.log('%cGame saved', 'color:#3498db;font-weight:900;');
    }

    public static getSaveObject() {
        const saveObject: Record<any, any> = {};

        Object.keys(App.game).filter(key => App.game[key].saveKey).forEach(key => {
            saveObject[App.game[key].saveKey] = App.game[key].toJSON();
        });
        saveObject.achievements = AchievementHandler.toJSON();

        return saveObject;
    }

    public static load(): Player {
        const saved = localStorage.getItem(`player${Save.key}`);

        // Load our settings, or the saved default settings, or no settings
        const settings = localStorage.getItem(`settings${Save.key}`) || localStorage.getItem('settings') || '{}';
        PrivateGameplay.resetSettingsForLoad();
        PartyController.resetListFilters();
        Settings.getSetting('partyDisplayValue').set(-1);
        Settings.fromJSON(JSON.parse(settings));

        // Sort modules now, save settings, load settings
        SortModules();

        if (saved !== 'null') {
            return new Player(JSON.parse(saved));
        } else {
            return new Player();
        }
    }

    public static async download() {
        const backupSaveData = {player, save: this.getSaveObject(), settings: Settings.toJSON()};
        try {
            const downloaded = await SaveSelector.downloadSaveData(backupSaveData, App.game.update.version);

            if (downloaded) {
                App.game.saveReminder.lastDownloaded(App.game.statistics.secondsPlayed());
            }
        } catch (err) {
            console.error('Error trying to download save', err);
            Notifier.notify({
                title: 'Failed to download save data',
                message: 'Please check the console for errors, and report them on our Discord.',
                type: NotificationConstants.NotificationOption.primary,
                timeout: 6e4,
            });
            try {
                localStorage.backupSave = JSON.stringify(backupSaveData);
            } catch (e) {}
        }
    }

    public static async copySaveToClipboard() {
        const getSaveString = () => SaveSelector.btoa(JSON.stringify({player, save: this.getSaveObject(), settings: Settings.toJSON()}));
        try {
            if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
                // Serialializing a large save can outlast the user-gesture window on slow
                // devices, so hand the clipboard a promise and serialize after write() starts
                const saveData = Promise.resolve().then(() => new Blob([getSaveString()], { type: 'text/plain' }));
                try {
                    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': saveData })]);
                } catch (err) {
                    // Some browsers don't accept promise-based ClipboardItem data
                    await navigator.clipboard.writeText(getSaveString());
                }
            } else {
                await navigator.clipboard.writeText(getSaveString());
            }
            Notifier.notify({
                title: 'Save copied',
                message: 'Please paste the clipboard contents into a new \'.txt\' file.',
                type: NotificationConstants.NotificationOption.info,
            });
        } catch (err) {
            console.error('Error trying to copy save', err);
            Notifier.notify({
                title: 'Failed to copy save data',
                message: 'Please try the Download Save button instead.',
                type: NotificationConstants.NotificationOption.danger,
                timeout: 6e4,
            });
        }
    }

    public static async delete(): Promise<void> {
        const key = Save.key;
        const confirmDelete = await Notifier.prompt({
            title: 'Delete save file',
            message: 'Are you sure you want delete your save file?\n\nTo confirm, type "DELETE"',
            type: NotificationConstants.NotificationOption.danger,
            timeout: 6e4,
        });

        if (confirmDelete == 'DELETE') {
            try {
                await CloudSave.beforeDelete(key);
            } catch (error) {
                CloudSave.reportError(error instanceof Error ? error.message : '存档删除失败。');
                return;
            }
            localStorage.removeItem(`player${key}`);
            localStorage.removeItem(`save${key}`);
            localStorage.removeItem(`settings${key}`);
            // Prevent the old save from being saved again
            window.onbeforeunload = () => {};
            location.reload();
        }
    }

    /** Filters an object by property names
     * @param     object : any The object you want to filter
     * @param       keep : string[] An array of property names that should be kept
     * @returns {Object} : The original object with only the specified properties
     */
    public static filter(object: any, keep: string[]): Record<string, any> {
        const filtered = {};
        let prop;
        for (prop in object) {
            if (keep.includes(prop)) {
                filtered[prop] = object[prop];
            }
        }
        return filtered;
    }

    public static initializeMultipliers(): { [name: string]: number } {
        const res = {};
        for (const obj in ItemList) {
            res[obj] = 1;
        }
        return res;
    }

    public static initializeItemlist(): { [name: string]: KnockoutObservable<number> } {
        const res = {};
        for (const obj in ItemList) {
            res[obj] = ko.observable(0).extend({ numeric: 0 });
        }
        return res;
    }

    public static initializeGems(saved?: Array<Array<number>>): Array<Array<KnockoutObservable<number>>> {
        let res;
        if (saved) {
            res = saved.map((type) => {
                return type.map((effectiveness) => {
                    return ko.observable(effectiveness);
                });
            });
        } else {
            res = [];
            for (const item in PokemonType) {
                if (!isNaN(Number(item))) {
                    res[item] = [];
                    res[item][GameConstants.TypeEffectiveness.Immune] = ko.observable(0);
                    res[item][GameConstants.TypeEffectiveness.NotVery] = ko.observable(0);
                    res[item][GameConstants.TypeEffectiveness.Neutral] = ko.observable(0);
                    res[item][GameConstants.TypeEffectiveness.Very] = ko.observable(0);
                }
            }
        }

        return res;
    }

    public static initializeEffects(saved?: Array<string>): { [name: string]: KnockoutObservable<number> } {
        const res = {};
        for (const obj in GameConstants.BattleItemType) {
            res[obj] = ko.observable(saved ? saved[obj] || 0 : 0);
        }
        for (const obj in GameConstants.FluteItemType) {
            res[obj] = ko.observable(saved ? saved[obj] || 0 : 0);
        }
        return res;
    }

    public static initializeEffectTimer(): { [name: string]: KnockoutObservable<string> } {
        const res = {};
        for (const obj in GameConstants.BattleItemType) {
            res[obj] = ko.observable('00:00');
        }
        for (const obj in GameConstants.FluteItemType) {
            res[obj] = ko.observable('00:00');
        }
        return res;
    }

    public static async loadFromFile(file: File) {
        if (!file) {
            return;
        }
        try {
            await CloudSave.importFile(file);
        } catch (error) {
            CloudSave.reportError(error instanceof Error ? error.message : '存档导入失败。');
        }
    }

}

Save satisfies TmpSaveType;
