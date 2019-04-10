/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    BaseTechnique,
    BufferAttribute,
    DecodedTile,
    ExtrudedPolygonTechnique,
    FillTechnique,
    Geometry,
    GeometryKind,
    getArrayConstructor,
    getPropertyValue,
    isCirclesTechnique,
    isDashedLineTechnique,
    isExtrudedLineTechnique,
    isExtrudedPolygonTechnique,
    isFillTechnique,
    isSolidLineTechnique,
    isSquaresTechnique,
    isStandardTechnique,
    isStandardTexturedTechnique,
    LineMarkerTechnique,
    PoiTechnique,
    StandardExtrudedLineTechnique,
    Technique,
    TextPathGeometry,
    TextTechnique
} from "@here/harp-datasource-protocol";
import {
    DashedLineMaterial,
    EdgeMaterial,
    EdgeMaterialParameters,
    FadingFeature,
    MapMeshBasicMaterial,
    SolidLineMaterial
} from "@here/harp-materials";
import {
    ContextualArabicConverter,
    FontStyle,
    FontUnit,
    FontVariant,
    HorizontalAlignment,
    TextLayoutStyle,
    TextRenderStyle,
    VerticalAlignment
} from "@here/harp-text-canvas";
import { assert, getOptionValue } from "@here/harp-utils";
import * as THREE from "three";

import { ColorCache } from "./ColorCache";
import { createMaterial, getBufferAttribute, getObjectConstructor } from "./DecodedTileHelpers";
import {
    createDepthPrePassMesh,
    isRenderDepthPrePassEnabled,
    setDepthPrePassStencil
} from "./DepthPrePass";
import { MapViewPoints } from "./MapViewPoints";
import { TextElement } from "./text/TextElement";
import { DEFAULT_TEXT_DISTANCE_SCALE } from "./text/TextElementsRenderer";
import { computeStyleCacheId } from "./text/TextStyleCache";
import { FadingParameters, PolygonFadingParameters, Tile, TileFeatureData } from "./Tile";

/**
 * The SORT_WEIGHT_PATH_LENGTH constants control how the priority of the labels are computed based
 * on the length of the label strings.
 *
 * Consequently, the [[Technique]]s priority is slightly modified while generating
 * [[TextElement]]s from the [[DecodedTile]], to get a more meaningful priority and stable results.
 */

/**
 * Gives [[TextElement]]s with longer paths a higher priority.
 */
const SORT_WEIGHT_PATH_LENGTH = 0.1;

export class TileGeometryCreator {
    private static m_colorMap: Map<string, THREE.Color> = new Map();

    private m_maxPathLengthSqr: number | undefined;

    /**
     * Called after the `Tile` has been decoded.
     *
     * @param tile The [[Tile]] to process.
     * @param decodedTile The [[DecodedTile]].
     */
    createAllGeometries(
        tile: Tile,
        decodedTile: DecodedTile,
        enabledKinds: Set<GeometryKind> | undefined
    ) {
        tile.clear();
        this.preparePois(tile, decodedTile);
        this.createTextElements(tile, decodedTile);
        this.createBackground(tile);
        this.createObjects(tile, decodedTile);
    }

    /**
     * Adds a THREE object to the root of the tile. Sets the owning tiles datasource.name and the
     * tileKey in the `userData` property of the object, such that the tile it belongs to can be
     * identified during picking.
     *
     * @param tile The [[Tile]] to add the object to.
     * @param object The object to add to the root of the tile.
     * @param kind The kind of object. Can be used for filtering.
     */
    registerTileObject(tile: Tile, object: THREE.Object3D, kind: GeometryKind) {
        const userData = object.userData || {};
        userData.tileKey = tile.tileKey;
        userData.dataSource = tile.dataSource.name;

        assert(kind !== undefined);
        userData.kind = kind;
    }

    createPlane(
        width: number,
        height: number,
        planeCenter: THREE.Vector3,
        colorHex: number,
        isVisible: boolean
    ): THREE.Mesh {
        const geometry = new THREE.PlaneGeometry(width, height, 1);
        // TODO cache the material HARP-4207
        const material = new MapMeshBasicMaterial({
            color: colorHex,
            visible: isVisible,
            // All 2D ground geometry is rendered with renderOrder set and with depthTest === false.
            depthTest: false
        });
        const plane = new THREE.Mesh(geometry, material);
        plane.position.copy(planeCenter);
        // Render before everything else
        plane.renderOrder = Number.MIN_SAFE_INTEGER;
        return plane;
    }

    /**
     * Add a ground plane to the tile.
     *
     * @param {Tile} tile
     */
    createBackground(tile: Tile) {
        const dataSource = tile.dataSource;
        if (!dataSource.addTileBackground) {
            return;
        }
        const mapView = tile.mapView;
        const objects = tile.objects;

        const planeSize = new THREE.Vector3();
        tile.boundingBox.getSize(planeSize);
        const groundPlane = this.createPlane(
            planeSize.x,
            planeSize.y,
            tile.center,
            dataSource.tileBackgroundColor === undefined
                ? mapView.clearColor
                : dataSource.tileBackgroundColor,
            dataSource.tileBackgroundIsVisible
        );

        this.registerTileObject(tile, groundPlane, GeometryKind.Background);
        objects.push(groundPlane);
    }

    /**
     * Creates `Tile` objects from the decoded tile and list of materials specified.
     *
     * @param tile The [[Tile]] to process.
     * @param decodedTile The [[DecodedTile]].
     * @param techniqueFilter: Optional filter. Should return true for any technique that is
     *      applicable.
     */
    createObjects(
        tile: Tile,
        decodedTile: DecodedTile,
        techniqueFilter?: (technique: Technique) => boolean
    ) {
        const materials: THREE.Material[] = [];
        const displayZoomLevel = tile.mapView.zoomLevel;
        const mapView = tile.mapView;
        const dataSource = tile.dataSource;
        const objects = tile.objects;

        for (const srcGeometry of decodedTile.geometries) {
            const groups = srcGeometry.groups;
            const groupCount = groups.length;

            for (let groupIndex = 0; groupIndex < groupCount; ) {
                const group = groups[groupIndex++];
                const techniqueIndex = group.technique;
                const technique = decodedTile.techniques[techniqueIndex];

                if (techniqueFilter !== undefined && !techniqueFilter(technique)) {
                    continue;
                }

                const start = group.start;
                let count = group.count;

                // compress consecutive groups
                for (
                    ;
                    groupIndex < groupCount && groups[groupIndex].technique === techniqueIndex;
                    ++groupIndex
                ) {
                    if (start + count !== groups[groupIndex].start) {
                        break;
                    }

                    count += groups[groupIndex].count;
                }

                const ObjectCtor = getObjectConstructor(technique);

                if (ObjectCtor === undefined) {
                    continue;
                }

                let material: THREE.Material | undefined = materials[techniqueIndex];

                if (material === undefined) {
                    const onMaterialUpdated = () => {
                        dataSource.requestUpdate();
                    };
                    material = createMaterial(
                        {
                            technique,
                            level: Math.floor(displayZoomLevel),
                            fog: mapView.scene.fog !== null
                        },
                        onMaterialUpdated
                    );
                    if (material === undefined) {
                        continue;
                    }
                    materials[techniqueIndex] = material;
                }

                const bufferGeometry = new THREE.BufferGeometry();

                srcGeometry.vertexAttributes.forEach(vertexAttribute => {
                    const buffer = getBufferAttribute(vertexAttribute);
                    bufferGeometry.addAttribute(vertexAttribute.name, buffer);
                });

                if (srcGeometry.interleavedVertexAttributes !== undefined) {
                    srcGeometry.interleavedVertexAttributes.forEach(attr => {
                        const ArrayCtor = getArrayConstructor(attr.type);
                        const buffer = new THREE.InterleavedBuffer(
                            new ArrayCtor(attr.buffer),
                            attr.stride
                        );
                        attr.attributes.forEach(interleavedAttr => {
                            const attribute = new THREE.InterleavedBufferAttribute(
                                buffer,
                                interleavedAttr.itemSize,
                                interleavedAttr.offset,
                                false
                            );
                            bufferGeometry.addAttribute(interleavedAttr.name, attribute);
                        });
                    });
                }

                if (srcGeometry.index) {
                    bufferGeometry.setIndex(getBufferAttribute(srcGeometry.index));
                }

                if (
                    !bufferGeometry.getAttribute("normal") &&
                    (isStandardTechnique(technique) || isStandardTexturedTechnique(technique))
                ) {
                    bufferGeometry.computeVertexNormals();
                }

                bufferGeometry.addGroup(start, count);

                if (isSolidLineTechnique(technique) || isDashedLineTechnique(technique)) {
                    const lineMaterial = material as THREE.RawShaderMaterial;
                    lineMaterial.uniforms.opacity.value = material.opacity;

                    if (technique.clipping !== false) {
                        const tileSize = lineMaterial.uniforms.tileSize;
                        const size = new THREE.Vector3();
                        tile.boundingBox.getSize(size);
                        tileSize.value.x = size.x;
                        tileSize.value.y = size.y;
                        lineMaterial.defines.TILE_CLIP = 1;
                    }
                }

                // Add polygon offset to the extruded buildings and to the fill area to avoid depth
                // problems when rendering edges.
                const hasExtrudedOutlines: boolean =
                    isExtrudedPolygonTechnique(technique) && srcGeometry.edgeIndex !== undefined;
                const hasFillOutlines: boolean =
                    isFillTechnique(technique) && srcGeometry.edgeIndex !== undefined;
                if (hasExtrudedOutlines || hasFillOutlines) {
                    material.polygonOffset = true;
                    material.polygonOffsetFactor = 0.75;
                    material.polygonOffsetUnits = 4.0;
                }

                const object = new ObjectCtor(bufferGeometry, material);

                object.frustumCulled = false;

                if (technique.renderOrder !== undefined) {
                    object.renderOrder = technique.renderOrder;
                } else {
                    if (technique._renderOrderAuto === undefined) {
                        throw new Error("Technique has no renderOrderAuto");
                    }
                    object.renderOrder = technique._renderOrderAuto;
                }

                if (group.renderOrderOffset !== undefined) {
                    object.renderOrder += group.renderOrderOffset;
                }

                if (srcGeometry.uuid !== undefined) {
                    object.userData.geometryId = srcGeometry.uuid;
                }

                if (
                    (isCirclesTechnique(technique) || isSquaresTechnique(technique)) &&
                    technique.enablePicking !== undefined
                ) {
                    (object as MapViewPoints).enableRayTesting = technique.enablePicking;
                }

                // Lines renderOrder fix: Render them as transparent objects, but make sure they end
                // up in the opaque rendering queue (by disabling transparency onAfterRender, and
                // enabling it onBeforeRender).
                if (isSolidLineTechnique(technique) || isDashedLineTechnique(technique)) {
                    const fadingParams = this.getFadingParams(displayZoomLevel, technique);
                    FadingFeature.addRenderHelper(
                        object,
                        fadingParams.fadeNear,
                        fadingParams.fadeFar,
                        true,
                        false,
                        (renderer, mat) => {
                            const lineMaterial = mat as SolidLineMaterial;

                            const metricUnits = getPropertyValue(
                                technique.metricUnit,
                                tile.tileKey.level
                            );
                            const unitFactor =
                                metricUnits === "Pixel" ? mapView.pixelToWorld * 0.5 : 1.0;

                            lineMaterial.lineWidth =
                                getOptionValue(
                                    getPropertyValue(technique.lineWidth, displayZoomLevel),
                                    SolidLineMaterial.DEFAULT_WIDTH
                                ) * unitFactor;

                            // Do the same for dashSize and gapSize for dashed lines.
                            if (isDashedLineTechnique(technique)) {
                                const dashedLineMaterial = lineMaterial as DashedLineMaterial;

                                dashedLineMaterial.dashSize =
                                    getOptionValue(
                                        getPropertyValue(technique.dashSize, displayZoomLevel),
                                        DashedLineMaterial.DEFAULT_DASH_SIZE
                                    ) * unitFactor;

                                dashedLineMaterial.gapSize =
                                    getOptionValue(
                                        getPropertyValue(technique.gapSize, displayZoomLevel),
                                        DashedLineMaterial.DEFAULT_GAP_SIZE
                                    ) * unitFactor;
                            }
                        }
                    );
                }

                if (isExtrudedLineTechnique(technique)) {
                    // extruded lines are normal meshes, and need transparency only when fading
                    // is defined.
                    if (technique.fadeFar !== undefined) {
                        const fadingParams = this.getFadingParams(
                            displayZoomLevel,
                            technique as StandardExtrudedLineTechnique
                        );
                        FadingFeature.addRenderHelper(
                            object,
                            fadingParams.fadeNear,
                            fadingParams.fadeFar,
                            true,
                            true
                        );
                    }
                }

                this.addFeatureData(srcGeometry, technique, object);

                if (isExtrudedPolygonTechnique(technique) || isFillTechnique(technique)) {
                    // filled polygons are normal meshes, and need transparency only when fading is
                    // defined.
                    if (technique.fadeFar !== undefined) {
                        const fadingParams = this.getFadingParams(displayZoomLevel, technique);
                        FadingFeature.addRenderHelper(
                            object,
                            fadingParams.fadeNear,
                            fadingParams.fadeFar,
                            true,
                            true
                        );
                    }
                }

                const renderDepthPrePass =
                    technique.name === "extruded-polygon" && isRenderDepthPrePassEnabled(technique);

                if (renderDepthPrePass) {
                    const depthPassMesh = createDepthPrePassMesh(object as THREE.Mesh);
                    objects.push(depthPassMesh);

                    setDepthPrePassStencil(depthPassMesh, object as THREE.Mesh);
                }

                this.registerTileObject(tile, object, technique.geometryKind!);
                objects.push(object);

                // Add the extruded building edges as a separate geometry.
                if (hasExtrudedOutlines) {
                    const edgeGeometry = new THREE.BufferGeometry();
                    edgeGeometry.addAttribute("position", bufferGeometry.getAttribute("position"));
                    edgeGeometry.addAttribute("color", bufferGeometry.getAttribute("color"));
                    edgeGeometry.setIndex(
                        getBufferAttribute(srcGeometry.edgeIndex! as BufferAttribute)
                    );

                    // Read the uniforms from the technique values (and apply the default values).
                    const extrudedPolygonTechnique = technique as ExtrudedPolygonTechnique;

                    const fadingParams = this.getPolygonFadingParams(
                        displayZoomLevel,
                        extrudedPolygonTechnique
                    );

                    // Configure the edge material based on the theme values.
                    const materialParams: EdgeMaterialParameters = {
                        color: fadingParams.color,
                        colorMix: fadingParams.colorMix,
                        fadeNear: fadingParams.lineFadeNear,
                        fadeFar: fadingParams.lineFadeFar
                    };
                    const edgeMaterial = new EdgeMaterial(materialParams);
                    const edgeObj = new THREE.LineSegments(edgeGeometry, edgeMaterial);

                    // Set the correct render order.
                    edgeObj.renderOrder = object.renderOrder + 0.1;

                    FadingFeature.addRenderHelper(
                        edgeObj,
                        fadingParams.lineFadeNear,
                        fadingParams.lineFadeFar,
                        false,
                        false
                    );

                    this.registerTileObject(tile, edgeObj, technique.geometryKind!);
                    objects.push(edgeObj);
                }

                // Add the fill area edges as a separate geometry.
                if (hasFillOutlines) {
                    const edgeIndexBuffers = srcGeometry.edgeIndex! as BufferAttribute[];
                    for (const edgeIndexBufferAttribute of edgeIndexBuffers) {
                        const outlineGeometry = new THREE.BufferGeometry();
                        outlineGeometry.addAttribute(
                            "position",
                            bufferGeometry.getAttribute("position")
                        );
                        outlineGeometry.setIndex(getBufferAttribute(edgeIndexBufferAttribute));

                        const fillTechnique = technique as FillTechnique;

                        const fadingParams = this.getPolygonFadingParams(
                            displayZoomLevel,
                            fillTechnique
                        );

                        // Configure the edge material based on the theme values.
                        const materialParams: EdgeMaterialParameters = {
                            color: fadingParams.color,
                            colorMix: fadingParams.colorMix,
                            fadeNear: fadingParams.lineFadeNear,
                            fadeFar: fadingParams.lineFadeFar
                        };
                        const outlineMaterial = new EdgeMaterial(materialParams);
                        const outlineObj = new THREE.LineSegments(outlineGeometry, outlineMaterial);
                        outlineObj.renderOrder = object.renderOrder + 0.1;

                        FadingFeature.addRenderHelper(
                            outlineObj,
                            fadingParams.lineFadeNear,
                            fadingParams.lineFadeFar,
                            true,
                            false
                        );

                        this.registerTileObject(tile, outlineObj, fillTechnique.geometryKind!);
                        objects.push(outlineObj);
                    }
                }
            }
        }
    }

    /**
     * Splits the text paths that contain sharp corners.
     *
     * @param textPathGeometries The original path geometries that may have defects.
     */
    prepareTextPaths(decodedTile: DecodedTile): TextPathGeometry[] {
        const processedPaths = new Array<TextPathGeometry>();

        const MAX_CORNER_ANGLE = Math.PI / 8;

        if (decodedTile.textPathGeometries === undefined) {
            return [];
        }

        const newPaths = decodedTile.textPathGeometries.slice();

        // maximum reuse of variables to reduce allocations
        const p0 = new THREE.Vector2();
        const p1 = new THREE.Vector2();
        const previousTangent = new THREE.Vector2();

        while (newPaths.length > 0) {
            const textPath = newPaths.pop();

            if (textPath === undefined) {
                break;
            }

            const technique = decodedTile.techniques[textPath.technique];
            if (technique.name !== "text") {
                continue;
            }

            let splitIndex = -1;

            for (let i = 0; i < textPath.path.length - 2; i += 2) {
                p0.set(textPath.path[i], textPath.path[i + 1]);
                p1.set(textPath.path[i + 2], textPath.path[i + 3]);
                const tangent = p1.sub(p0).normalize();

                if (i > 0) {
                    const theta = Math.atan2(
                        previousTangent.x * tangent.y - tangent.x * previousTangent.y,
                        tangent.dot(previousTangent)
                    );

                    if (Math.abs(theta) > MAX_CORNER_ANGLE) {
                        splitIndex = i;
                        break;
                    }
                }
                previousTangent.set(tangent.x, tangent.y);
            }

            if (splitIndex > 0) {
                // split off the valid first path points with a clone of the path
                const firstTextPath = {
                    path: textPath.path.slice(0, splitIndex + 2),
                    text: textPath.text,
                    // Used for placement priorities only, can be kept although it could also be
                    // recomputed
                    pathLengthSqr: textPath.pathLengthSqr,
                    technique: textPath.technique,
                    featureId: textPath.featureId
                };

                processedPaths.push(firstTextPath);

                // setup a second part with the rest of the path points and process again
                const secondTextPath = {
                    path: textPath.path.slice(splitIndex),
                    text: textPath.text,
                    // Used for placement priorities only, can be kept although it could also be
                    // recomputed
                    pathLengthSqr: textPath.pathLengthSqr,
                    technique: textPath.technique,
                    featureId: textPath.featureId
                };

                newPaths.push(secondTextPath);
            } else {
                processedPaths.push(textPath);
            }
        }
        return processedPaths;
    }

    /**
     * Creates [[TextElement]] objects from the decoded tile and list of materials specified. The
     * priorities of the [[TextElement]]s are updated to simplify label placement.
     *
     * @param tile The [[Tile]] to process.
     * @param decodedTile The [[DecodedTile]].
     * @param textFilter: Optional filter. Should return true for any text technique that is
     *      applicable.
     */
    createTextElements(
        tile: Tile,
        decodedTile: DecodedTile,
        textFilter?: (technique: Technique) => boolean
    ) {
        // Prepare the text paths (cut at sharp corners) before the first TextElements are created.
        if (tile.preparedTextPaths === undefined) {
            const preparedTextPaths = this.prepareTextPaths(decodedTile);
            tile.preparedTextPaths = preparedTextPaths;

            // Compute maximum street length (squared). Longer streets should be labelled first,
            // they have a higher chance of being placed in case the number of text elements is
            // limited.
            this.m_maxPathLengthSqr = 0;
            for (const textPath of preparedTextPaths) {
                const technique = decodedTile.techniques[textPath.technique];
                if (technique.name !== "text") {
                    continue;
                }
                if (textPath.pathLengthSqr > this.m_maxPathLengthSqr) {
                    this.m_maxPathLengthSqr = textPath.pathLengthSqr;
                }
            }
        }

        const displayZoomLevel = Math.floor(tile.mapView.zoomLevel);

        if (tile.preparedTextPaths !== undefined) {
            for (const textPath of tile.preparedTextPaths) {
                const technique = decodedTile.techniques[textPath.technique];

                if (
                    technique.name !== "text" ||
                    (textFilter !== undefined && !textFilter(technique))
                ) {
                    continue;
                }

                const path: THREE.Vector2[] = [];
                for (let i = 0; i < textPath.path.length; i += 2) {
                    path.push(new THREE.Vector2(textPath.path[i], textPath.path[i + 1]));
                }

                // Make sorting stable and make pathLengthSqr a differentiator for placement.
                const priority =
                    getOptionValue(getPropertyValue(technique.priority, displayZoomLevel), 0) +
                    (this.m_maxPathLengthSqr! > 0
                        ? (SORT_WEIGHT_PATH_LENGTH * textPath.pathLengthSqr) /
                          this.m_maxPathLengthSqr!
                        : 0);

                const textElement = new TextElement(
                    ContextualArabicConverter.instance.convert(textPath.text),
                    path,
                    this.getRenderStyle(tile, technique),
                    this.getLayoutStyle(tile, technique),
                    priority,
                    technique.xOffset !== undefined ? technique.xOffset : 0.0,
                    technique.yOffset !== undefined ? technique.yOffset : 0.0,
                    textPath.featureId,
                    technique.style,
                    getPropertyValue(technique.fadeNear, displayZoomLevel),
                    getPropertyValue(technique.fadeFar, displayZoomLevel)
                );
                textElement.minZoomLevel =
                    technique.minZoomLevel !== undefined
                        ? technique.minZoomLevel
                        : tile.mapView.minZoomLevel;
                textElement.maxZoomLevel =
                    technique.maxZoomLevel !== undefined
                        ? technique.maxZoomLevel
                        : tile.mapView.maxZoomLevel;
                textElement.distanceScale =
                    technique.distanceScale !== undefined
                        ? technique.distanceScale
                        : DEFAULT_TEXT_DISTANCE_SCALE;
                textElement.mayOverlap = technique.mayOverlap === true;
                textElement.reserveSpace = technique.reserveSpace !== false;

                tile.addTextElement(textElement);
            }
        }

        if (decodedTile.textGeometries !== undefined) {
            for (const text of decodedTile.textGeometries) {
                if (text.technique === undefined || text.stringCatalog === undefined) {
                    continue;
                }

                const technique = decodedTile.techniques[text.technique];

                if (
                    technique.name !== "text" ||
                    (textFilter !== undefined && !textFilter(technique))
                ) {
                    continue;
                }

                const positions = new THREE.BufferAttribute(
                    new Float32Array(text.positions.buffer),
                    text.positions.itemCount
                );

                const numPositions = positions.count;
                if (numPositions < 1) {
                    continue;
                }

                const priority = getOptionValue(
                    getPropertyValue(technique.priority, displayZoomLevel),
                    0
                );

                for (let i = 0; i < numPositions; ++i) {
                    const x = positions.getX(i);
                    const y = positions.getY(i);
                    const label = text.stringCatalog[text.texts[i]];
                    if (label === undefined) {
                        // skip missing labels
                        continue;
                    }

                    const textElement = new TextElement(
                        ContextualArabicConverter.instance.convert(label!),
                        new THREE.Vector2(x, y),
                        this.getRenderStyle(tile, technique),
                        this.getLayoutStyle(tile, technique),
                        priority,
                        technique.xOffset || 0.0,
                        technique.yOffset || 0.0,
                        text.featureId,
                        technique.style
                    );

                    textElement.minZoomLevel =
                        technique.minZoomLevel !== undefined
                            ? technique.minZoomLevel
                            : tile.mapView.minZoomLevel;
                    textElement.maxZoomLevel =
                        technique.maxZoomLevel !== undefined
                            ? technique.maxZoomLevel
                            : tile.mapView.maxZoomLevel;
                    textElement.mayOverlap = technique.mayOverlap === true;
                    textElement.reserveSpace = technique.reserveSpace !== false;

                    textElement.fadeNear = getPropertyValue(technique.fadeNear, displayZoomLevel);
                    textElement.fadeFar = getPropertyValue(technique.fadeFar, displayZoomLevel);

                    tile.addTextElement(textElement);
                }
            }
        }
    }

    /**
     * Missing Typedoc
     */
    preparePois(tile: Tile, decodedTile: DecodedTile) {
        if (decodedTile.poiGeometries !== undefined) {
            tile.mapView.poiManager.addPois(tile, decodedTile);
        }
    }

    /**
     * Gets the appropriate [[TextRenderStyle]] to use for a label. Depends heavily on the label's
     * [[Technique]] and the current zoomLevel.
     *
     * @param tile The [[Tile]] to process.
     * @param technique Label's technique.
     * @param techniqueIdx Label's technique index.
     */
    getRenderStyle(
        tile: Tile,
        technique: TextTechnique | PoiTechnique | LineMarkerTechnique
    ): TextRenderStyle {
        const displayZoomLevel = tile.mapView.zoomLevel;
        const mapView = tile.mapView;
        const dataSource = tile.dataSource;

        const cacheId = computeStyleCacheId(dataSource.name, technique, displayZoomLevel);
        let renderStyle = mapView.textRenderStyleCache.get(cacheId);
        if (renderStyle === undefined) {
            const defaultRenderParams =
                mapView.textElementsRenderer !== undefined
                    ? mapView.textElementsRenderer.defaultStyle.renderParams
                    : {
                          fontSize: {
                              unit: FontUnit.Pixel,
                              size: 32,
                              backgroundSize: 8
                          }
                      };

            const textSize = getOptionValue(
                getPropertyValue(technique.size, Math.floor(displayZoomLevel)),
                defaultRenderParams.fontSize!.size
            );
            const bgSize = getOptionValue(
                getPropertyValue(technique.backgroundSize, Math.floor(displayZoomLevel)),
                defaultRenderParams.fontSize!.backgroundSize
            );

            const hexColor = getPropertyValue(technique.color, Math.floor(displayZoomLevel));
            if (hexColor !== undefined) {
                TileGeometryCreator.m_colorMap.set(cacheId, ColorCache.instance.getColor(hexColor));
            }
            const styleColor = getOptionValue(
                TileGeometryCreator.m_colorMap.get(cacheId),
                defaultRenderParams.color
            );

            const hexBgColor = getPropertyValue(
                technique.backgroundColor,
                Math.floor(displayZoomLevel)
            );
            if (hexBgColor !== undefined) {
                TileGeometryCreator.m_colorMap.set(
                    cacheId + "_bg",
                    ColorCache.instance.getColor(hexBgColor)
                );
            }
            const styleBgColor = getOptionValue(
                TileGeometryCreator.m_colorMap.get(cacheId + "_bg"),
                defaultRenderParams.backgroundColor
            );

            const bgAlpha = getOptionValue(
                getPropertyValue(technique.backgroundAlpha, Math.floor(displayZoomLevel)),
                defaultRenderParams.backgroundOpacity
            );

            const isSmallCaps =
                technique.smallCaps === true ||
                defaultRenderParams.fontVariant === FontVariant.SmallCaps;
            const isAllCaps =
                technique.allCaps === true ||
                defaultRenderParams.fontVariant === FontVariant.AllCaps;
            const styleFontVariant = isSmallCaps
                ? FontVariant.SmallCaps
                : isAllCaps
                ? FontVariant.AllCaps
                : undefined;
            const styleFontStyle =
                technique.bold === true
                    ? technique.oblique
                        ? FontStyle.BoldItalic
                        : FontStyle.Bold
                    : technique.oblique === true
                    ? FontStyle.Italic
                    : defaultRenderParams.fontStyle;

            const renderParams = {
                fontSize: {
                    unit: FontUnit.Pixel,
                    size: textSize,
                    backgroundSize: bgSize
                },
                color: styleColor,
                backgroundColor: styleBgColor,
                backgroundOpacity: bgAlpha,
                fontVariant: styleFontVariant,
                fontStyle: styleFontStyle
            };

            const themeRenderParams =
                mapView.textElementsRenderer !== undefined
                    ? mapView.textElementsRenderer!.getTextElementStyle(technique.style)
                          .renderParams
                    : {};
            renderStyle = new TextRenderStyle({
                ...themeRenderParams,
                ...renderParams
            });
            mapView.textRenderStyleCache.set(cacheId, renderStyle);
        }

        return renderStyle;
    }

    /**
     * Gets the appropriate [[TextRenderStyle]] to use for a label. Depends heavily on the label's
     * [[Technique]] and the current zoomLevel.
     *
     * @param tile The [[Tile]] to process.
     * @param technique Label's technique.
     */
    getLayoutStyle(
        tile: Tile,
        technique: TextTechnique | PoiTechnique | LineMarkerTechnique
    ): TextLayoutStyle {
        const mapView = tile.mapView;
        const dataSource = tile.dataSource;
        const cacheId = computeStyleCacheId(dataSource.name, technique, mapView.zoomLevel);
        let layoutStyle = mapView.textLayoutStyleCache.get(cacheId);
        if (layoutStyle === undefined) {
            const defaultLayoutParams =
                mapView.textElementsRenderer !== undefined
                    ? mapView.textElementsRenderer.defaultStyle.layoutParams
                    : {};

            const trackingFactor = getOptionValue(technique.tracking, defaultLayoutParams.tracking);
            let hAlignment = defaultLayoutParams.horizontalAlignment;
            if (
                technique.hAlignment === "Left" ||
                technique.hAlignment === "Center" ||
                technique.hAlignment === "Right"
            ) {
                hAlignment = HorizontalAlignment[technique.hAlignment];
            }
            let vAlignment = defaultLayoutParams.verticalAlignment;
            if (
                technique.vAlignment === "Above" ||
                technique.vAlignment === "Center" ||
                technique.vAlignment === "Below"
            ) {
                vAlignment = VerticalAlignment[technique.vAlignment];
            }

            const layoutParams = {
                tracking: trackingFactor,
                horizontalAlignment: hAlignment,
                verticalAlignment: vAlignment
            };

            const themeLayoutParams =
                mapView.textElementsRenderer !== undefined
                    ? mapView.textElementsRenderer!.getTextElementStyle(technique.style)
                          .layoutParams
                    : {};
            layoutStyle = new TextLayoutStyle({
                ...themeLayoutParams,
                ...layoutParams
            });
            mapView.textLayoutStyleCache.set(cacheId, layoutStyle);
        }

        return layoutStyle;
    }

    /**
     * Pass the feature data on to the object, so it can be used in picking
     * `MapView.intersectMapObjects()`. Do not pass the feature data if the technique is a
     * dashed-line or a solid-line, because the line picking functionality for the lines is not
     * object based, but tile based.
     *
     * @param srcGeometry The original [[Geometry]].
     * @param technique The corresponding [[Technique]].
     * @param object The object to pass info to.
     */
    private addFeatureData(srcGeometry: Geometry, technique: Technique, object: THREE.Object3D) {
        if (
            ((srcGeometry.featureIds !== undefined && srcGeometry.featureIds.length > 0) ||
                technique.name === "circles" ||
                technique.name === "squares") &&
            technique.name !== "solid-line" &&
            technique.name !== "dashed-line"
        ) {
            const featureData: TileFeatureData = {
                geometryType: srcGeometry.type,
                ids: srcGeometry.featureIds,
                starts: srcGeometry.featureStarts
            };
            object.userData.feature = featureData;

            if (srcGeometry.objInfos !== undefined) {
                object.userData.feature.objInfos = srcGeometry.objInfos;
            }
        }
    }

    /**
     * Gets the fading parameters for several kinds of objects.
     */
    private getFadingParams(displayZoomLevel: number, technique: BaseTechnique): FadingParameters {
        const fadeNear =
            technique.fadeNear !== undefined
                ? getPropertyValue(technique.fadeNear, displayZoomLevel)
                : FadingFeature.DEFAULT_FADE_NEAR;
        const fadeFar =
            technique.fadeFar !== undefined
                ? getPropertyValue(technique.fadeFar, displayZoomLevel)
                : FadingFeature.DEFAULT_FADE_FAR;
        return {
            fadeNear,
            fadeFar
        };
    }

    /**
     * Gets the fading parameters for several kinds of objects.
     */
    private getPolygonFadingParams(
        displayZoomLevel: number,
        technique: FillTechnique | ExtrudedPolygonTechnique
    ): PolygonFadingParameters {
        let color: string | number = EdgeMaterial.DEFAULT_COLOR;
        let colorMix = EdgeMaterial.DEFAULT_COLOR_MIX;

        if (technique.lineColor !== undefined) {
            color = technique.lineColor;
            if (isExtrudedPolygonTechnique(technique)) {
                const extrudedPolygonTechnique = technique as ExtrudedPolygonTechnique;
                colorMix =
                    extrudedPolygonTechnique.lineColorMix !== undefined
                        ? extrudedPolygonTechnique.lineColorMix
                        : EdgeMaterial.DEFAULT_COLOR_MIX;
            }
        }

        const fadeNear =
            technique.fadeNear !== undefined
                ? getPropertyValue(technique.fadeNear, displayZoomLevel)
                : FadingFeature.DEFAULT_FADE_NEAR;
        const fadeFar =
            technique.fadeFar !== undefined
                ? getPropertyValue(technique.fadeFar, displayZoomLevel)
                : FadingFeature.DEFAULT_FADE_FAR;

        const lineFadeNear =
            technique.lineFadeNear !== undefined
                ? getPropertyValue(technique.lineFadeNear, displayZoomLevel)
                : fadeNear;
        const lineFadeFar =
            technique.lineFadeFar !== undefined
                ? getPropertyValue(technique.lineFadeFar, displayZoomLevel)
                : fadeFar;

        return {
            color,
            colorMix,
            fadeNear,
            fadeFar,
            lineFadeNear,
            lineFadeFar
        };
    }
}
