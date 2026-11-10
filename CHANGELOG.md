# Changelog

## 0.6.1 (2026-11-10)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.
- The walkthrough ends with a step that links free Zovo extensions for the files that often come with this one. A link opens the extension page; nothing installs on its own.
- The footer reads "Rate · More free viewers · Zovo Pro, USD 19 · PayPal · Hide". "Zovo Pro, USD 19" and the Marketplace Sponsor button open the Zovo Pro tier; "PayPal" opens the PayPal steps with the amount.
- Zovo Pro buy path: the Pro message names the other Pro tools in NetCDF Viewer and the number of Zovo extensions Pro covers, with 4 buttons: Get Zovo Pro (USD 19), Pay with PayPal, I already paid, Cancel. "I already paid" turns Pro on with GitHub Sponsors or a license key.
- Turn Zovo Pro on once per computer: the other Zovo extensions you have pick it up from `~/.zovo/pro.json`, with no second sign-in or paste. After an unlock you get one offer to turn it on in your other Zovo tools; "Not now" is final.
- "Support the developer" lists Zovo Pro first. Every Pro link opens the USD 19 Zovo Pro tier on GitHub Sponsors, not the general Sponsors page.
- The 5 Zovo Pro commands share one "Zovo Pro" group in the Command Palette, with the same names in every Zovo extension.
- Nothing that was free changed. No popup on open.

## 0.6.0 (2026-11-09)

Everything that was free stays free. New, with the optional Zovo Pro (USD 19 once for every Zovo viewer; each tool has 3 free tries on your computer):

- Compare two files, like nccmp: variables in one file only, changed shapes, types and attributes, and every value of every numeric variable in both files, compared after CF decoding. Max and mean absolute difference, RMSE, values that differ, fill and NaN mismatches and the index of the largest difference. Setting `hdf5NetcdfExplorer.compareTolerance` for an absolute tolerance. The report has a filter and saves as CSV, Markdown or JSON.
- Export a subset of a variable, like `ncks -d`: a range per dimension by index, by coordinate value or by date, saved as NetCDF (with coordinates, attributes and a history line) or as a tidy CSV.
- "Compare with…" and "Export subset…" buttons, Command Palette commands and Explorer menu entries. `hdf5NetcdfExplorer.showProFeatures: false` hides them.
- A subset too big to save (more than 4 billion values, or more than 20 million for CSV) is refused before the file dialog, and it does not use a free try.
- Buying Zovo Pro: the README lists the PayPal steps (USD 19, or USD 59 for a team of 5) and the transaction ID form.

Also:

- The rating question comes after 2 files that opened without an error in 2 sessions at least 4 hours apart (was 3 files on 2 calendar days). It still never shows after an error, at most twice in all, and the setting turns it off.
- "Rate it" and the Rate link in the footer open the review page of the store your editor installs from: the Visual Studio Marketplace in VS Code, Open VSX in Cursor, Windsurf, VSCodium and other editors that use Open VSX.
- Rate is now the first footer link.

## 0.4.1 (2026-11-09)

- PayPal is now in the footer links and in the README "Support Zovo" section, next to GitHub Sponsors. Both are optional; the viewer works the same without them.
- No change to how files open or look.

## 0.4.0 (2026-11-08)

- Coastlines on maps. When a heatmap's rows and columns are latitude and longitude (found from CF units, standard names or the usual names), the Natural Earth 1:110m coastlines are drawn over it, and the saved PNG has them too. Grids from 0 to 360 and from -180 to 180 work, and north is at the top when latitude grows with the row number. A "Coastlines" checkbox turns them off.
- Play along a dimension. A ▶ button next to each slider steps through time, or any other dimension, with a speed menu (0.5×, 1×, 2×, Max). The next step starts only after the last one is drawn, and the colour range stays at the first frame's range so the frames compare. Escape, a slider move or another variable stops it.
- RGB images. An 8-bit dataset shaped height x width x 3 (or 4), or an HDF5 image marked `CLASS=IMAGE`, shows as one colour picture, with the R, G, B values under the mouse and Save PNG. Microscopy, EBSD and camera frames stored in HDF5 look the way they should. A checkbox switches back to the heatmap of one channel.
- NetCDF CDF-5 (64-bit data) files open. They are written by PnetCDF, WRF, E3SM and `nccopy -k cdf5`. The unsigned and 64-bit integer types are shown exactly; values above 2^53 show as text so no digit is lost.
- Fixed: a plot of a 2D field with more than 1,000,000 cells was refused, even though the plot reads only every Nth row and column. A 0.25 degree global grid (721 x 1440) now plots. Found while building the JetBrains version.
- Fixed: a buoy or station series stored as (time, lat=1, lon=1), as NDBC files are, opened as a 1 x 1 heatmap. It now opens as a line along time, and heatmaps skip dimensions of length 1. The Columns menu has a "none (line plot)" choice for any variable.
- Fixed: an HDF5 or NetCDF-4 file that was cut off during a copy or download now says so, with the expected and actual size, instead of a low-level read error.
- HDF5 compression plugins: datasets compressed with LZF, Blosc, Blosc2, bitshuffle, LZ4, Zstd, bzip2 or ZFP now read, through the h5wasm-plugins libraries. That covers h5py's `compression="lzf"`, hdf5plugin and detector files such as Dectris and ESRF images.
- Fixed: a dataset compressed with a filter the viewer could not decode showed made-up numbers from leftover memory. Found on a real ESRF detector file compressed with bitshuffle. Those filters are now read, and any other one (SZ, JPEG) gets a message that names it.
- Fixed: a big heatmap was squeezed or stretched when its rows and columns were sampled with different steps. A 720 x 1440 global grid drew at about 4:3 instead of 2:1. Both axes now share one step, so maps and pictures keep their shape.
- Fixed: an unlimited maximum shape shows as ∞ instead of 18446744073709552000.
- New name in the Marketplace: NetCDF Viewer & HDF5 Viewer (NC Viewer, H5 Viewer). The extension ID, settings and commands stay the same.
- More tools by Zovo and the More free viewers list use the current names of the related extensions.
- The rating question now comes after 3 files that opened without an error on 2 different days, and never after an error. "Later" asks one more time after 7 days, "No thanks" ends it, and it never asks more than 2 times. `hdf5NetcdfExplorer.askForRating: false` turns it off.

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
