/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    DecodedTile,
    GeometryKind,
    isDashedLineTechnique,
    isExtrudedLineTechnique,
    isExtrudedPolygonTechnique,
    isFillTechnique,
    isLineMarkerTechnique,
    isLineTechnique,
    isPoiTechnique,
    isSegmentsTechnique,
    isSolidLineTechnique,
    isTextTechnique,
    Technique
} from "@here/harp-datasource-protocol";
import { PerformanceTimer } from "@here/harp-utils";

import { PerformanceStatistics } from "./Statistics";
import { Tile } from "./Tile";
import { TileGeometryCreator } from "./TileGeometryCreator";

export interface TileGeometryLoader {
    isFinished: boolean;
    tile: Tile;
    basicGeometryLoaded: boolean;
    allGeometryLoaded: boolean;
    update(enabledKinds: Set<GeometryKind> | undefined): void;
    dispose(): void;
}

export class SimpleTileGeometryLoader implements TileGeometryLoader {
    private m_decodedTile?: DecodedTile;
    private m_isFinished: boolean = false;

    constructor(private m_tile: Tile) {}

    get tile(): Tile {
        return this.m_tile;
    }

    get basicGeometryLoaded(): boolean {
        return this.m_isFinished;
    }

    get allGeometryLoaded(): boolean {
        return this.m_isFinished;
    }

    get isFinished(): boolean {
        return this.m_isFinished;
    }

    setDecodedTile(decodedTile: DecodedTile) {
        this.m_decodedTile = this.m_tile.decodedTile;
    }

    update(enabledKinds?: Set<GeometryKind>): void {
        if (this.m_decodedTile === undefined && this.m_tile.decodedTile !== undefined) {
            this.setDecodedTile(this.m_tile.decodedTile);
            this.prepareForRender(enabledKinds);
            this.finish();
        }
    }

    dispose(): void {
        this.m_decodedTile = undefined;
    }

    private finish() {
        this.m_tile.removeDecodedTile();
        this.m_isFinished = true;
    }

    /**
     * Called by [[VisibleTileSet]] to mark that [[Tile]] is visible and it should prepare geometry.
     */
    private prepareForRender(enabledKinds: Set<GeometryKind> | undefined) {
        // If the tile is not ready for display, or if it has become invisible while being loaded,
        // for example by moving the camera, the tile is not finished and its geometry is not
        // created. This is an optimization for fast camera movements and zooms.
        const tile = this.tile;
        const decodedTile = this.m_decodedTile;
        this.m_decodedTile = undefined;
        if (decodedTile === undefined || tile.disposed || !tile.isVisible) {
            return;
        }
        setTimeout(() => {
            const stats = PerformanceStatistics.instance;
            // If the tile has become invisible while being loaded, for example by moving the
            // camera, the tile is not finished and its geometry is not created. This is an
            // optimization for fast camera movements and zooms.
            if (!tile.isVisible) {
                // Dispose the tile from the visible set, so it can be reloaded properly next time
                // it is needed.
                tile.mapView.visibleTileSet.disposeTile(tile);
                if (stats.enabled) {
                    stats.currentFrame.addMessage(
                        `Decoded tile: ${tile.dataSource.name} # lvl=${tile.tileKey.level} col=${
                            tile.tileKey.column
                        } row=${tile.tileKey.row} DISCARDED - invisible`
                    );
                }
                return;
            }
            let now = 0;
            if (stats.enabled) {
                now = PerformanceTimer.now();
            }

            const geometryCreator = new TileGeometryCreator();
            geometryCreator.createAllGeometries(tile, decodedTile, enabledKinds);

            if (stats.enabled) {
                const geometryCreationTime = PerformanceTimer.now() - now;
                const currentFrame = stats.currentFrame;
                currentFrame.addValue("geometry.geometryCreationTime", geometryCreationTime);
                currentFrame.addValue("geometryCount.numGeometries", decodedTile.geometries.length);
                currentFrame.addValue("geometryCount.numTechniques", decodedTile.techniques.length);
                currentFrame.addValue(
                    "geometryCount.numPoiGeometries",
                    decodedTile.poiGeometries !== undefined ? decodedTile.poiGeometries.length : 0
                );
                currentFrame.addValue(
                    "geometryCount.numTextGeometries",
                    decodedTile.textGeometries !== undefined ? decodedTile.textGeometries.length : 0
                );
                currentFrame.addValue(
                    "geometryCount.numTextPathGeometries",
                    decodedTile.textPathGeometries !== undefined
                        ? decodedTile.textPathGeometries.length
                        : 0
                );
                currentFrame.addMessage(
                    `Decoded tile: ${tile.dataSource.name} # lvl=${tile.tileKey.level} col=${
                        tile.tileKey.column
                    } row=${tile.tileKey.row}`
                );
            }
            this.finish();
            tile.dataSource.requestUpdate();
        }, 0);
    }
}

export type PhaseList = GeometryKind[];

/**
 *
 *
 */
export class PhasedTileGeometryLoader implements TileGeometryLoader {
    private m_decodedTile?: DecodedTile;
    private m_isFinished: boolean = false;
    private m_geometryKindsLoaded: Set<GeometryKind> = new Set();
    private m_loadPhaseDefinitions: PhaseList[];
    private m_currentPhaseIndex = 0;

    constructor(
        private m_tile: Tile,
        loadPhaseDefinitions: PhaseList[],
        private m_basicGeometryKinds: Set<GeometryKind>
    ) {
        this.m_loadPhaseDefinitions = loadPhaseDefinitions;
    }

    get currentPhase(): number {
        return this.m_currentPhaseIndex;
    }

    nextPhase(): number | undefined {
        if (this.m_currentPhaseIndex < this.m_loadPhaseDefinitions.length) {
            this.m_currentPhaseIndex++;
        }

        return this.m_currentPhaseIndex < this.m_loadPhaseDefinitions.length
            ? this.m_currentPhaseIndex
            : undefined;
    }

    get numberOfPhases(): number {
        return this.m_loadPhaseDefinitions.length;
    }

    get kindsCreated(): Set<GeometryKind> {
        return this.m_geometryKindsLoaded;
    }

    get basicGeometryLoaded(): boolean {
        for (const phase of this.m_basicGeometryKinds) {
            if (!this.m_geometryKindsLoaded.has(phase)) {
                return false;
            }
        }
        return true;
    }

    get allGeometryLoaded(): boolean {
        return this.currentPhase >= this.m_loadPhaseDefinitions.length;
    }

    get tile(): Tile {
        return this.m_tile;
    }

    setDecodedTile(decodedTile: DecodedTile) {
        this.m_decodedTile = decodedTile;
        this.m_currentPhaseIndex = 0;
        this.m_geometryKindsLoaded.clear();
    }

    updateCompletely(enabledKinds: Set<GeometryKind> | undefined): boolean {
        return this.update(enabledKinds, true);
    }

    updateToPhase(toPhase: number, enabledKinds: Set<GeometryKind> | undefined): boolean {
        let didUpdate = false;
        while (this.currentPhase < toPhase) {
            didUpdate = this.update(enabledKinds);
            if (!didUpdate) {
                break;
            }
        }
        return didUpdate;
    }

    update(enabledKinds: Set<GeometryKind> | undefined, doFullUpdate: boolean = false): boolean {
        if (this.m_decodedTile === undefined && this.m_tile.decodedTile !== undefined) {
            this.setDecodedTile(this.m_tile.decodedTile);
            this.processTechniques();
        }

        if (!this.tile.dataSource.cacheable) {
            this.m_currentPhaseIndex = this.m_loadPhaseDefinitions.length;
            return false;
        }

        const currentPhase = this.currentPhase;
        if (this.m_decodedTile === undefined || currentPhase >= this.numberOfPhases) {
            return false;
        }

        const stats = PerformanceStatistics.instance;
        let now = 0;

        if (stats.enabled) {
            now = PerformanceTimer.now();
        }

        if (doFullUpdate) {
            const geometryCreator = new TileGeometryCreator();
            geometryCreator.createAllGeometries(this.m_tile, this.m_decodedTile, enabledKinds);

            // Mark it as finished.
            this.m_currentPhaseIndex = this.m_loadPhaseDefinitions.length;
        } else {
            const currentPhaseDefinition = this.m_loadPhaseDefinitions[currentPhase];
            const geometryCreator = new TileGeometryCreator();

            for (const kind of currentPhaseDefinition) {
                this.createKind(geometryCreator, kind);
            }
        }

        if (stats.enabled) {
            stats.currentFrame.addValue(
                "geometry.geometryCreationTime",
                PerformanceTimer.now() - now
            );
        }

        if (this.nextPhase() === undefined) {
            // All done, update the stats
            if (stats.enabled) {
                const currentFrame = stats.currentFrame;
                const decodedTile = this.m_decodedTile;
                const tile = this.m_tile;

                currentFrame.addValue("geometryCount.numGeometries", decodedTile.geometries.length);
                currentFrame.addValue("geometryCount.numTechniques", decodedTile.techniques.length);
                currentFrame.addValue(
                    "geometryCount.numPoiGeometries",
                    decodedTile.poiGeometries !== undefined ? decodedTile.poiGeometries.length : 0
                );
                currentFrame.addValue(
                    "geometryCount.numTextGeometries",
                    decodedTile.textGeometries !== undefined ? decodedTile.textGeometries.length : 0
                );
                currentFrame.addValue(
                    "geometryCount.numTextPathGeometries",
                    decodedTile.textPathGeometries !== undefined
                        ? decodedTile.textPathGeometries.length
                        : 0
                );
                currentFrame.addMessage(
                    `Decoded tile: ${tile.dataSource.name} # lvl=${tile.tileKey.level} col=${
                        tile.tileKey.column
                    } row=${tile.tileKey.row}`
                );
            }

            this.finish();
        }
        return true;
    }

    getTextElementPriorities(): number[] | undefined {
        if (this.m_decodedTile === undefined) {
            return undefined;
        }

        const priorities: Set<number> = new Set();
        for (const technique of this.m_decodedTile.techniques) {
            if (technique.name !== "text") {
                continue;
            }
            priorities.add(technique.priority !== undefined ? technique.priority : 0);
        }
        const prioritiesArray = Array.from(priorities);
        return prioritiesArray.sort((a: number, b: number) => {
            return b - a;
        });
    }

    get isFinished(): boolean {
        return this.m_isFinished;
    }

    dispose(): void {
        this.m_decodedTile = undefined;
    }

    protected createKind(geometryCreator: TileGeometryCreator, kind: GeometryKind): void {
        if (this.m_geometryKindsLoaded.has(kind)) {
            return;
        }
        this.m_geometryKindsLoaded.add(kind);

        const tile = this.tile;
        const decodedTile = this.m_decodedTile;

        if (kind === GeometryKind.Background) {
            // this.tile.forceHasGeometry(true);
            // geometryCreator.createBackground(this.tile);
        } else if (decodedTile !== undefined) {
            if (!tile.hasGeometry) {
                // tile.forceHasGeometry(true);
                geometryCreator.createBackground(tile);
            }

            let filter: ((technique: Technique) => boolean) | undefined;

            if (kind === GeometryKind.Area) {
                filter = (technique: Technique): boolean => {
                    return isFillTechnique(technique);
                };
            } else if (kind === GeometryKind.Line) {
                filter = (technique: Technique): boolean => {
                    return (
                        isLineTechnique(technique) ||
                        isDashedLineTechnique(technique) ||
                        isSolidLineTechnique(technique) ||
                        isSegmentsTechnique(technique) ||
                        isExtrudedLineTechnique(technique)
                    );
                };
            } else if (kind === GeometryKind.Building) {
                filter = (technique: Technique): boolean => {
                    return isExtrudedPolygonTechnique(technique);
                };
            } else if (kind === GeometryKind.Label) {
                const textFilter = (technique: Technique): boolean => {
                    return (
                        isPoiTechnique(technique) ||
                        isLineMarkerTechnique(technique) ||
                        isTextTechnique(technique)
                    );
                };

                // const textPriorities = this.getTextElementPriorities();

                // TextElements do not get their geometry created by Tile, but are managed on a
                // higher level.
                geometryCreator.createTextElements(tile, decodedTile, textFilter);

                geometryCreator.preparePois(tile, decodedTile);
            }

            if (filter !== undefined) {
                geometryCreator.createObjects(tile, decodedTile, filter);
            }
        }
    }

    protected processTechniques(): void {
        const decodedTile = this.m_decodedTile;

        if (decodedTile === undefined) {
            return;
        }

        for (const technique of decodedTile.techniques) {
            // Make sure that all technique have their geometryKind set, either from the Theme or
            // their default value.
            let geometryKind = technique.geometryKind;

            // Set default kind based on technique.
            if (geometryKind === undefined) {
                if (isFillTechnique(technique)) {
                    geometryKind = GeometryKind.Area;
                } else if (
                    isLineTechnique(technique) ||
                    isDashedLineTechnique(technique) ||
                    isSolidLineTechnique(technique) ||
                    isSegmentsTechnique(technique) ||
                    isExtrudedLineTechnique(technique)
                ) {
                    geometryKind = GeometryKind.Line;
                } else if (isExtrudedPolygonTechnique(technique)) {
                    geometryKind = GeometryKind.Building;
                } else if (
                    isPoiTechnique(technique) ||
                    isLineMarkerTechnique(technique) ||
                    isTextTechnique(technique)
                ) {
                    geometryKind = GeometryKind.Label;
                } else {
                    geometryKind = GeometryKind.None;
                }

                technique.geometryKind = geometryKind;
            }
        }
    }

    private finish() {
        this.m_decodedTile = undefined;
        this.m_tile.removeDecodedTile();
        this.m_isFinished = true;
    }
}
