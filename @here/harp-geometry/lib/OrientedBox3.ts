/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { OrientedBox3Like } from "@here/harp-geoutils";
import { Frustum, Matrix4, Plane, Vector3 } from "three";

export class OrientedBox3 implements OrientedBox3Like {
    /**
     * The position of the center of this `OrientedBox3`.
     */
    readonly position = new Vector3();

    /**
     * The x-axis of this `OrientedBox3`.
     */
    readonly xAxis = new Vector3(1, 0, 0);

    /**
     * The y-axis of this `OrientedBox3`.
     */
    readonly yAxis = new Vector3(0, 1, 0);

    /**
     * The z-axis of this `OrientedBox3`.
     */
    readonly zAxis = new Vector3(0, 0, 1);

    /**
     * The extents of this `OrientedBox3`.
     */
    readonly extents = new Vector3();

    /**
     * Creates a new `OrientedBox3`.
     */
    constructor();

    /**
     * Creates a new `OrientedBox3` with the given position, orientation and extents.
     *
     * @param position The position of the center of the `OrientedBox3`.
     * @param rotationMatrix The rotation of the `OrientedBox3`.
     * @param extents The extents of the `OrientedBox3`.
     */
    constructor(position: Vector3, rotationMatrix: Matrix4, extents: Vector3);

    /**
     * Creates a new `OrientedBox3`.
     *
     * @hideconstructor
     */
    constructor(position?: Vector3, rotationMatrix?: Matrix4, extents?: Vector3) {
        if (position !== undefined) {
            this.position.copy(position);
        }

        if (rotationMatrix !== undefined) {
            rotationMatrix.extractBasis(this.xAxis, this.yAxis, this.zAxis);
        }

        if (extents !== undefined) {
            this.extents.copy(extents);
        }
    }

    /**
     * Gets the orientation matrix of this `OrientedBox3`.
     * @param matrix The output orientation matrix.
     */
    getRotationMatrix(matrix: Matrix4 = new Matrix4()): Matrix4 {
        return matrix.makeBasis(this.xAxis, this.yAxis, this.zAxis);
    }

    /**
     * Checks intersection with the given `THREE.Frustum` or array of `THREE.Plane`s.
     *
     * @param frustumOrPlanes Frustum or array of planes.
     */
    intersects(frustumOrPlanes: Plane[] | Frustum): boolean {
        const planes: Plane[] = Array.isArray(frustumOrPlanes)
            ? frustumOrPlanes
            : frustumOrPlanes.planes;

        for (const plane of planes) {
            const r =
                Math.abs(plane.normal.dot(this.xAxis) * this.extents.x) +
                Math.abs(plane.normal.dot(this.yAxis) * this.extents.y) +
                Math.abs(plane.normal.dot(this.zAxis) * this.extents.z);

            const d = plane.distanceToPoint(this.position);

            if (d + r < 0) {
                return false;
            }
        }

        return true;
    }
}
