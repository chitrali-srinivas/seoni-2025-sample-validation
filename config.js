// Published with the page (GitHub Pages). Holds only browser-safe values: never put the service_role key here.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://dukeqyoxcrttzesivakq.supabase.co',
  // Publishable / anon key (safe in the browser — RLS protects the data)
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR1a2VxeW94Y3J0dHplc2l2YWtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NDA0MjQsImV4cCI6MjEwMzIxNjQyNH0.QGQD7eWNr5Fjnl13hLkF_Jj5HprCyJLxnWx7zy78otA',
  // Browser key with "Maps JavaScript API" enabled; restrict it to your site's HTTP referrers
  GOOGLE_MAPS_API_KEY: 'AIzaSyAxMTJPRieLISCoq1j6F96bzHWKJ4ZXWG0',

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
