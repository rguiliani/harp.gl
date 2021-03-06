/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:only-arrow-functions
// Mocha discourages using arrow functions, see https://mochajs.org/#arrow-functions

import {
    GeometryType,
    isStandardTexturedTechnique,
    MapEnv,
    StandardTexturedTechnique,
    StyleSetEvaluator,
    Technique
} from "@here/harp-datasource-protocol";
import {
    GeoCoordinates,
    mercatorProjection,
    TileKey,
    webMercatorTilingScheme
} from "@here/harp-geoutils";
import { assert } from "chai";
import { Box3, Vector3 } from "three";
import { IPolygonGeometry } from "../lib/IGeometryProcessor";
import { OmvDecodedTileEmitter } from "../lib/OmvDecodedTileEmitter";
import { OmvDecoder } from "../lib/OmvDecoder";

describe("OmvDecodedTileEmitter", function() {
    it("Ring data conversion to polygon data: whole tile square shape", function() {
        const tileKey = TileKey.fromRowColumnLevel(0, 0, 1);
        const projection = mercatorProjection;
        const geoBox = webMercatorTilingScheme.getGeoBox(tileKey);
        const tileBounds = projection.projectBox(geoBox, new Box3());
        const center = tileBounds.getCenter(new Vector3());
        const tileSizeOnScreen = 100;

        const polygons: IPolygonGeometry[] = [
            {
                rings: [
                    {
                        coordinates: [
                            new GeoCoordinates(geoBox.south, geoBox.west),
                            new GeoCoordinates(geoBox.south, geoBox.east),
                            new GeoCoordinates(geoBox.north, geoBox.east),
                            new GeoCoordinates(geoBox.north, geoBox.west)
                        ]
                    }
                ]
            }
        ];

        const decodeInfo: OmvDecoder.DecodeInfo = {
            tileKey,
            projection,
            geoBox,
            tileBounds,
            center,
            tileSizeOnScreen
        };

        const technique: StandardTexturedTechnique = {
            name: "standard-textured",
            _index: 0
        };

        class MockStyleSetEvaluator {
            constructor(readonly m_techniques: Technique[]) {}

            get techniques(): Technique[] {
                return this.m_techniques;
            }
        }

        const mockStyleSetEvaluator = new MockStyleSetEvaluator([technique]);

        const tileEmmiter = new OmvDecodedTileEmitter(
            decodeInfo,
            (mockStyleSetEvaluator as any) as StyleSetEvaluator,
            false,
            false
        );

        const mockEnv = new MapEnv({});

        tileEmmiter.processPolygonFeature("mock-layer", polygons, mockEnv, [technique], undefined);

        const decodedTile = tileEmmiter.getDecodedTile();

        const { techniques, geometries } = decodedTile;

        assert.equal(techniques.length, 1, "only one technique created");
        assert.equal(
            isStandardTexturedTechnique(techniques[0]),
            true,
            "created technique is standard textured technique"
        );
        assert.equal(geometries.length, 1, "only one geometry created");
        assert.equal(geometries[0].type, GeometryType.Polygon, "geometry is a polygon");
        assert.equal(geometries[0].vertexAttributes.length, 2);
        const positions = geometries[0].vertexAttributes[0];
        const texCoords = geometries[0].vertexAttributes[1];
        assert.equal(positions.name, "position", "geometry has position attribute");
        assert.equal(texCoords.name, "uv", "geometry has texture coordinates");
        assert.equal(positions.type, "float", "positions are floats");
        assert.equal(texCoords.type, "float", "texture coordinates are floats");

        const positionsBuffer = new Float32Array(positions.buffer);
        const texCoordsBuffer = new Float32Array(texCoords.buffer);
        const positionCount = positionsBuffer.length / positions.itemCount;
        const texCoordCount = texCoordsBuffer.length / texCoords.itemCount;
        assert.equal(positionCount, 4);
        assert.equal(texCoordCount, 4);

        const eps = 1e-15;
        assert.closeTo(texCoordsBuffer[0], 0, eps);
        assert.closeTo(texCoordsBuffer[1], 0, eps);

        assert.closeTo(texCoordsBuffer[2], 1, eps);
        assert.closeTo(texCoordsBuffer[3], 0, eps);

        assert.closeTo(texCoordsBuffer[4], 1, eps);
        assert.closeTo(texCoordsBuffer[5], 1, eps);

        assert.closeTo(texCoordsBuffer[6], 0, eps);
        assert.closeTo(texCoordsBuffer[7], 1, eps);
    });
});
