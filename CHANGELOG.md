# Changelog

## 0.3.0 (2026-11-07)

- New name in the Marketplace: NetCDF Viewer & HDF5 Viewer (NC, H5). The extension ID, settings and commands stay the same.
- Plot controls above the heatmap: 8 colour maps, Reverse, a colour range (2-98 percentile as before, min to max, symmetric around 0, from the variable's range attributes, or custom numbers) and a log scale. The new setting `hdf5NetcdfExplorer.colormap` sets the colour map a heatmap starts with.
- "Save PNG" saves the heatmap, a line plot or a point series as a PNG file next to the data file. The picture has a title with the variable, units and slider positions, plus axis labels and the colour bar.
- Click a heatmap cell on a variable with 3 or more dimensions to plot that point along time or another dimension, with decoded dates. "Copy as CSV" copies the series.

## 0.2.3 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.2.2 (2026-11-07)

- The footer under the viewer has a "Rate" link next to Sponsor and More free viewers. It opens the review page of this extension on the Marketplace. Nothing pops up and nothing asks you for a rating. "Hide" still hides the whole line.
- Marketplace search keywords updated.

## 0.2.1 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first, starting with GGUF, Safetensors & NPY Viewer (NumPy Viewer).

## 0.2.0 (2026-11-06)

- A new "Export slice…" button saves the slice on screen as CSV or JSON. You pick the file in a save dialog, and its extension sets the format. The file holds every row and column of the two chosen dimensions, not only the page on screen. Coordinate values are the headers, CF decoding follows the checkbox, and fill values are empty cells. The JSON file also records the variable, units and the index and value of each dimension fixed by a slider. A message offers to open the new file.
- HDF5 files with other names open too. `.jld2` (Julia), `.loom`, `.h5mu`, `.hf5`, `.h5oina`, `.h5ebsd`, `.edaxh5`, `.oh5`, `.dream3d`, `.geoh5`, `.nde` and `.cxi` open in the viewer by default. For MATLAB 7.3 `.mat` files and any other name, "HDF5 NetCDF Explorer (any file)" is listed in "Reopen Editor With…", and the Explorer menu item covers `.mat` and the new extensions.
- "HDF5 NetCDF: Open in HDF5 NetCDF Explorer" from the Command Palette now opens the file in the active tab, even when VS Code shows it as binary.
- An older MATLAB v5 `.mat` file gets a clear message that tells you to save it with `-v7.3`.
- The view also reloads when a script deletes the file and writes it again.
- In a narrow editor (under about 560 px, for example a split view), the tree now sits above the details. Before, the details column could shrink to a few letters.

## 0.1.4 (2026-11-06)

- The Marketplace page now starts with a screenshot of a real VS Code window with a NetCDF heatmap, and a short GIF of picking a variable, moving the time slider and opening the Table tab. Both were made from generated sample files. The images load from the GitHub repo and are not packed into the extension, so the download size stays the same.
- The file overview no longer prints the word "null" under the item count when a file has no dimension list.

## 0.1.3 (2026-11-06)

- A small line at the bottom right of the explorer has two links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `hdf5NetcdfExplorer.showSupportLinks` (default `true`) hides it, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "HDF5 NetCDF: Support the developer" and "HDF5 NetCDF: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.2 (2026-11-06)

- HDF5 & NetCDF Explorer asks one time for a Marketplace rating. It counts each success (an opened HDF5 or NetCDF file). After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `hdf5NetcdfExplorer.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.

## 0.1.1 (2026-11-06)

- Listing only, no change to the extension. The display name is now "HDF5 & NetCDF Explorer (H5 Viewer)" and the description is one sentence, so the listing uses the words people search for (hdf5 (6), netcdf (6), h5 viewer (5)).
- The 30 keywords start with the most searched terms.
- The README ends with links to the other Zovo extensions.

## 0.1.0 (2026-11-06)

- First release, an HDF5, NetCDF-4 and NetCDF-3 viewer with tree, attributes, CF decoding, paged table, line plot and heatmap.
