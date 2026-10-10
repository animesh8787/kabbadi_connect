declare module "maplibre-gl/dist/maplibre-gl-csp" {
  import maplibregl from "maplibre-gl";
  export * from "maplibre-gl";
  export default maplibregl;
}
declare module "maplibre-gl/dist/maplibre-gl-csp-worker?url" {
  const url: string;
  export default url;
}
