# Changelog

## 0.1.2 (2026-11-06)

- HDF5 & NetCDF Explorer asks one time for a Marketplace rating. It counts each success (an opened HDF5 or NetCDF file). After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `hdf5NetcdfExplorer.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.

## 0.1.1 (2026-11-06)

- Listing only, no change to the extension. The display name is now "HDF5 & NetCDF Explorer (H5 Viewer)" and the description is one sentence, so the listing uses the words people search for (hdf5 (6), netcdf (6), h5 viewer (5)).
- The 30 keywords start with the most searched terms.
- The README ends with links to the other Zovo extensions.

## 0.1.0 (2026-11-06)

- First release: HDF5, NetCDF-4 and NetCDF-3 viewer with tree, attributes, CF decoding, paged table, line plot and heatmap.
