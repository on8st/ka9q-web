// Every distinct feature reachable in the stock UI (html/radio.html +
// html/optionsDialog.html), grouped by function rather than 1:1 per DOM
// id (several ids are just multiple controls for one feature - e.g.
// spectrum_min/spectrum_max are both "spectrum display range"). Grouped
// this way because the brief's invariant is about *features* staying
// reachable, not literal DOM ids matching.
//
// `stockIds`: the stock control(s) this feature is built from - checked
// against the real file by check-parity.mjs so this manifest can't drift
// from reality without the check catching it.
// `instrumentId`: the corresponding element/feature in html/instrument/,
// or null if not yet built. A string here is a claim the check verifies;
// null is an honest, checked-in gap, not a silent omission.
export const PARITY_MANIFEST = [
  { feature: "Frequency tuning (type exact value)", stockIds: ["freq"], instrumentId: "freq-entry" },
  { feature: "Frequency tuning (click-to-step digits)", stockIds: ["freq"], instrumentId: "vfo-digits" },
  { feature: "Mode selection", stockIds: ["mode"], instrumentId: "tuned-mode" },
  { feature: "Tuning step size", stockIds: ["step"], instrumentId: "step-value" },
  { feature: "Band quick-select", stockIds: ["band", "band_category"], instrumentId: "band-chips" },
  { feature: "Memory save", stockIds: ["save_memory", "memory_desc"], instrumentId: "mem-save" },
  { feature: "Memory recall", stockIds: ["recall_memory", "memory_select"], instrumentId: "mem-list" },
  { feature: "Memory delete", stockIds: ["delete_memory"], instrumentId: "mem-list" },
  { feature: "Memory import/export as a set", stockIds: ["import_memories", "export_memories", "import_memories_btn"], instrumentId: null },
  { feature: "Zoom level", stockIds: ["zoom_level", "zoomplus", "zoomminus"], instrumentId: null },
  { feature: "Zoom to a clicked centre", stockIds: ["zoomcenter"], instrumentId: null },
  { feature: "Spectrum display size", stockIds: ["spectrum_size_up", "spectrum_size_down"], instrumentId: null },
  { feature: "Spectrum display range (dB floor/ceiling)", stockIds: ["spectrum_min", "spectrum_max"], instrumentId: "display-area" },
  { feature: "Spectrum autoscale", stockIds: ["autoscale", "ckonlyAutoscaleButton"], instrumentId: null },
  { feature: "Spectrum freeze min/max", stockIds: ["freeze_min_max"], instrumentId: null },
  { feature: "Spectrum baseline adjust", stockIds: ["baseline_up", "baseline_down", "rangeinc", "rangedec"], instrumentId: null },
  { feature: "Waterfall display range", stockIds: ["waterfall_min", "waterfall_max", "waterfall_min_range", "waterfall_max_range"], instrumentId: "display-area" },
  { feature: "Waterfall colour bias", stockIds: ["waterfallBiasInput"], instrumentId: null },
  { feature: "Colormap selection", stockIds: ["colormap"], instrumentId: null },
  { feature: "FFT averaging amount", stockIds: ["fft_avg_input", "spectrum_average_input"], instrumentId: null },
  { feature: "Max/min hold", stockIds: ["max_hold", "check_max", "check_min", "check_live", "decay_list"], instrumentId: null },
  { feature: "FFT window type/shape", stockIds: ["windowTypeSelect", "spectrumShapeInput", "sendWindowParamButton"], instrumentId: null },
  { feature: "Spectrum overlap", stockIds: ["spectrumOverlapInput", "sendSpectrumOverlapButton"], instrumentId: null },
  { feature: "Spectrum poll rate", stockIds: ["spectrumPollInput", "spectrumPollButton"], instrumentId: null },
  { feature: "Pause display", stockIds: ["pause"], instrumentId: "pause-toggle" },
  { feature: "Cursor / panning", stockIds: ["cursor", "panner_control"], instrumentId: null },
  { feature: "Filter edges (bandwidth)", stockIds: ["filterLowInput", "filterHighInput", "edge_button"], instrumentId: null },
  { feature: "CW shift/offset", stockIds: ["shiftInput", "sendShiftButton", "cw_instant_button", "cw_upper_input", "cw_lower_input", "cw_save_button"], instrumentId: null },
  { feature: "Keep frequency centred", stockIds: ["ckKeepFreqCentered"], instrumentId: null },
  { feature: "Audio volume", stockIds: ["volume_control"], instrumentId: "audio-volume" },
  { feature: "Audio play/mute", stockIds: ["audio_button"], instrumentId: "audio-toggle" },
  { feature: "PCM/Opus output toggle", stockIds: ["pcm_checkbox"], instrumentId: "audio-pcm" },
  { feature: "Audio recording", stockIds: ["toggleRecording"], instrumentId: "audio-record" },
  { feature: "S-meter metric (Signal/SNR/OVR)", stockIds: ["meter"], instrumentId: null },
  { feature: "S-meter style (bar vs analog)", stockIds: ["ckAnalogSMeter"], instrumentId: "ck-analog" },
  { feature: "Show ham band edge markers", stockIds: ["ckShowBandEdges"], instrumentId: null },
  { feature: "Hide DC/centre-bin spike (this fork's own feature)", stockIds: ["ckHideDcSpike"], instrumentId: null },
  { feature: "Spectrum fill style", stockIds: ["ckNoSpectrumFill"], instrumentId: null },
  { feature: "Status-bar frequency display", stockIds: ["cksbFrequency"], instrumentId: null },
  { feature: "Spectrum/waterfall CSV export", stockIds: ["ExportData", "ExportMin", "ExportMax", "csv_out", "csvMinuteInput", "load_max"], instrumentId: "export-csv" },
  { feature: "Clear waterfall overlay / reset", stockIds: ["clear_overlay", "reset"], instrumentId: null },
  { feature: "Options/settings panel", stockIds: ["OptionsButton", "closeXButton"], instrumentId: "rare-things" },
  { feature: "Alternate frequency display", stockIds: ["alternate_freq_buttons"], instrumentId: null },
];
