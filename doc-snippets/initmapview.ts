const mapView = new MapView({
    canvas: document.getElementById("mapCanvas") as HTMLCanvasElement,
    theme: "resources/berlin_tilezen_night_reduced.json"
});
CopyrightElementHandler.install("copyrightNotice", mapView);
mapView.camera.position.set(1900000, 3350000, 2500000); // Europe.
mapView.geoCenter = new GeoCoordinates(16, -4, 0);
mapView.resize(window.innerWidth, window.innerHeight);
window.addEventListener("resize", () => {
    mapView.resize(window.innerWidth, window.innerHeight);
});
const hereCopyrightInfo: CopyrightInfo = {
    id: "here.com",
    year: new Date().getFullYear(),
    label: "HERE",
    link: "https://legal.here.com/terms"
};
const copyrights: CopyrightInfo[] = [hereCopyrightInfo];
const baseMap = new OmvDataSource({
    baseUrl: "https://xyz.api.here.com/tiles/herebase.02",
    apiFormat: APIFormat.XYZOMV,
    styleSetName: "tilezen",
    maxZoomLevel: 17,
    authenticationCode: accessToken,
    copyrightInfo: copyrights
});
mapView.addDataSource(baseMap);
