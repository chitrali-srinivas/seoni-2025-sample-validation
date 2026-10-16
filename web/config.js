// Copy to config.js and fill in. config.js is git-ignored.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://dukeqyoxcrttzesivakq.supabase.co',
  // Publishable / anon key (safe in the browser — RLS protects the data)
  SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-KEY',
  // Browser key with "Maps JavaScript API" enabled; restrict it to your site's HTTP referrers
  GOOGLE_MAPS_API_KEY: 'YOUR-GOOGLE-MAPS-API-KEY',

  // Overlap below this many m² is treated as numerical noise when suggesting answers.
  // Anything above it is a conflict (rules say plots must never intersect).
  OVERLAP_TOLERANCE_M2: 1,
  // A control plot overlapping a treatment plot by at least this % (of the smaller plot)
  // is suggested as "actually a treatment plot".
  SAME_PLOT_OVERLAP_PCT: 50,
  // Data is loaded per selected village. Zoom level from which all deployment plots
  // of the loaded villages are drawn, and the most plots that may be loaded at once.
  ALL_PLOTS_MIN_ZOOM: 13,
  MAX_PLOTS_LOADED: 8000,

  MAP_CENTER: { lat: 22.08, lng: 79.9 },
  MAP_ZOOM: 11,
};
