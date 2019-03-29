/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import { GeometryKind } from "@here/harp-datasource-protocol";
import { LoggerManager } from "@here/harp-utils/lib/Logger";

import { MapView } from "./MapView";
import { Tile } from "./Tile";
import {
    PhasedTileGeometryLoader,
    PhaseList,
    SimpleTileGeometryLoader,
    TileGeometryLoader
} from "./TileGeometryLoader";

const logger = LoggerManager.instance.create("TileGeometryManager");

interface TileGeometryState {
    tile: Tile;
    geometryLoader: TileGeometryLoader;
}

export interface TileGeometryManager {
    readonly availableGeometryKinds: Set<GeometryKind>;
    readonly enabledGeometryKinds: Set<GeometryKind>;

    initTile(tiles: Tile): void;

    updateTiles(tiles: Tile[]): void;

    clear(): void;

    enableGeometryKind(
        kind: GeometryKind | GeometryKind[] | Set<GeometryKind>,
        enable: boolean
    ): void;
}

abstract class TileGeometryManagerBase implements TileGeometryManager {
    protected availableKinds: Set<GeometryKind> = new Set();
    protected enabledKinds: Set<GeometryKind> = new Set();

    protected enableFilterByKind: boolean = false;

    constructor(protected mapView: MapView) {}

    abstract initTile(tile: Tile): void;

    abstract updateTiles(tiles: Tile[]): void;

    abstract clear(): void;

    enableGeometryKind(
        kind: GeometryKind | GeometryKind[] | Set<GeometryKind>,
        enable: boolean
    ): void {
        if (Array.isArray(kind)) {
            for (const oneKind of kind as GeometryKind[]) {
                if (enable) {
                    this.enabledKinds.add(oneKind);
                } else {
                    this.enabledKinds.delete(oneKind);
                }
            }
        } else if (kind instanceof Set) {
            const kindSet = kind as Set<GeometryKind>;
            for (const oneKind of kindSet) {
                if (enable) {
                    this.enabledKinds.add(oneKind);
                } else {
                    this.enabledKinds.delete(oneKind);
                }
            }
        } else if (kind) {
            if (enable) {
                this.enabledKinds.add(kind);
            } else {
                this.enabledKinds.delete(kind);
            }
        }
    }

    get availableGeometryKinds(): Set<GeometryKind> {
        return this.availableKinds;
    }

    set filterByKindEnabled(enable: boolean) {
        this.enableFilterByKind = enable;
    }

    get filterByKindEnabled(): boolean {
        return this.enableFilterByKind;
    }

    get enabledGeometryKinds(): Set<GeometryKind> {
        return this.enabledKinds;
    }
}

export class SimpleTileGeometryManager extends TileGeometryManagerBase {
    constructor(mapView: MapView) {
        super(mapView);
    }

    initTile(tile: Tile): void {
        tile.tileGeometryLoader = new SimpleTileGeometryLoader(tile);
    }

    updateTiles(tiles: Tile[]): void {
        for (const tile of tiles) {
            const geometryLoader = tile.tileGeometryLoader as TileGeometryLoader;
            if (geometryLoader !== undefined) {
                geometryLoader.update(
                    this.filterByKindEnabled ? this.enabledGeometryKinds : undefined
                );
            }
        }
    }

    clear(): void {
        //
    }
}

const DefaultPhases: PhaseList[] = [
    [GeometryKind.Background, GeometryKind.Ground, GeometryKind.Area],
    [GeometryKind.Line, GeometryKind.Road],
    [GeometryKind.Building],
    [GeometryKind.Label],
    [GeometryKind.Detail],
    [GeometryKind.None]
];

const DefaultBasicGeometryKinds: Set<GeometryKind> = new Set([
    GeometryKind.Background,
    GeometryKind.Ground,
    GeometryKind.Area,
    GeometryKind.Line
]);

export class PhasedTileGeometryManager extends TileGeometryManagerBase {
    private m_maximumUpdatesPerFrame = 5;
    private m_loadPhaseDefinitions: PhaseList[] = DefaultPhases;
    private m_basicGeometryKinds: Set<GeometryKind> = DefaultBasicGeometryKinds;

    constructor(mapView: MapView) {
        super(mapView);
    }

    initTile(tile: Tile): void {
        tile.tileGeometryLoader = new PhasedTileGeometryLoader(
            tile,
            this.m_loadPhaseDefinitions,
            this.m_basicGeometryKinds
        );
    }

    updateTiles(tiles: Tile[]): void {
        // if (this.updateTilesCompletely(tiles)) {
        //     this.mapView.update();
        // }

        if (this.mapView.isDynamicFrame) {
            this.updateAllTiles(tiles);
        } else {
            this.updateTilesTogether(tiles);
        }

        if (!this.checkTilesFinished(tiles)) {
            this.mapView.update();
        }
    }

    clear() {
        //
    }

    private checkTilesFinished(tiles: Tile[]): boolean {
        for (const tile of tiles) {
            const phasedGeometryLoader = tile.tileGeometryLoader as PhasedTileGeometryLoader;
            if (phasedGeometryLoader !== undefined && !phasedGeometryLoader.allGeometryLoaded) {
                return false;
            }
        }
        return true;
    }

    private updateAllTiles(tiles: Tile[]) {
        let numTilesUpdated = 0;
        for (const tile of tiles) {
            const phasedGeometryLoader = tile.tileGeometryLoader as PhasedTileGeometryLoader;

            if (
                phasedGeometryLoader !== undefined &&
                phasedGeometryLoader.update(
                    this.filterByKindEnabled ? this.enabledGeometryKinds : undefined
                )
            ) {
                numTilesUpdated++;
                if (
                    this.m_maximumUpdatesPerFrame > 0 &&
                    numTilesUpdated >= this.m_maximumUpdatesPerFrame &&
                    tile.mapView.isDynamicFrame
                ) {
                    break;
                }
            }
        }
    }

    private updateTilesCompletely(tiles: Tile[]): boolean {
        let didUpdate = false;
        for (const tile of tiles) {
            const phasedGeometryLoader = tile.tileGeometryLoader as PhasedTileGeometryLoader;
            if (phasedGeometryLoader !== undefined) {
                didUpdate =
                    didUpdate ||
                    phasedGeometryLoader.updateCompletely(
                        this.filterByKindEnabled ? this.enabledGeometryKinds : undefined
                    );
            }
        }
        return didUpdate;
    }

    private updateTilesTogether(tiles: Tile[]): void {
        let lowestPhase: number | undefined;

        for (const tile of tiles) {
            const phasedGeometryLoader = tile.tileGeometryLoader as PhasedTileGeometryLoader;

            if (
                phasedGeometryLoader !== undefined &&
                (lowestPhase === undefined || phasedGeometryLoader.currentPhase < lowestPhase)
            ) {
                lowestPhase = phasedGeometryLoader.currentPhase;
            }
        }

        if (lowestPhase !== undefined && lowestPhase < this.m_loadPhaseDefinitions.length) {
            const nextPhase = lowestPhase + 1;
            this.updateTilesIfNeeded(tiles, nextPhase);
        }
    }

    private updateTilesIfNeeded(tiles: Tile[], toPhase: number) {
        let numTilesUpdated = 0;
        for (const tile of tiles) {
            const phasedGeometryLoader = tile.tileGeometryLoader as PhasedTileGeometryLoader;
            if (
                phasedGeometryLoader !== undefined &&
                phasedGeometryLoader.updateToPhase(
                    toPhase,
                    this.filterByKindEnabled ? this.enabledGeometryKinds : undefined
                )
            ) {
                numTilesUpdated++;
                if (
                    tile.mapView.isDynamicFrame &&
                    this.m_maximumUpdatesPerFrame > 0 &&
                    numTilesUpdated >= this.m_maximumUpdatesPerFrame
                ) {
                    break;
                }
            }
        }
    }
}
