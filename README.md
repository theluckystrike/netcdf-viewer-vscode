# NetCDF Viewer & HDF5 Viewer (NC Viewer, H5 Viewer)

A NetCDF viewer and HDF5 viewer for climate and lab scientists who keep data in `.nc` or `.h5` files. It shows the variables, their CF metadata, the values and a map inside VS Code. No Python, no NCL, nothing to set up.

New in 0.6.0: two optional Pro tools, each with 3 free tries. Everything that was free stays free.

- Compare two files, like nccmp: variables in one file only, changed shapes, types and attributes, and every value of every variable in both files, compared after CF decoding. Per variable: max and mean absolute difference, RMSE, how many values differ (with an optional tolerance), fill and NaN mismatches and where the largest difference is.
- Export a subset, like `ncks -d` or xarray `.sel`: pick a variable and a range for each dimension, by index (`0:99`, `0:99:2`) or by value (`30..60`, `2023-08-01..2023-08-31`). Save it as a NetCDF file with its coordinates and attributes, or as a tidy CSV with one row per point.

New in 0.4.0: coastlines on latitude-longitude maps, a Play button that steps through time, NetCDF CDF-5 (64-bit data) files, and full plots of grids over 1 million cells, such as a 0.25 degree global field (721 x 1440).

![NetCDF viewer in VS Code: NOAA OISST daily sea surface temperature for 2023 (a 450 MB NetCDF-4 file, 365 x 720 x 1440) drawn as a map with coastlines on 1 August 2023, and below it the series of the clicked point at 30.6 S, 135.6 W over the whole year](https://raw.githubusercontent.com/theluckystrike/netcdf-viewer-vscode/main/images/vscode-netcdf-map-series.png)

*A real VS Code window running version 0.4.0 on `sst.day.mean.2023.nc` from NOAA PSL (OISST v2 high resolution, daily, 2023). The map is sampled to every 3rd latitude and longitude, so it keeps its 2:1 shape, and drew in about 0.1 s. A click on the map plotted that point over 365 days.*

![Play along time: the same map stepping through August 2023 at 2x speed, with the colour range held at the first frame's range](https://raw.githubusercontent.com/theluckystrike/netcdf-viewer-vscode/main/images/demo-play.gif)

*Play (▶ next to the time slider) on the same 450 MB file, recorded frame by frame in VS Code.*

![VS Code engine](https://img.shields.io/badge/VS%20Code-%5E1.90-0B2A3C) ![License MIT](https://img.shields.io/badge/license-MIT-0B2A3C) ![Works offline](https://img.shields.io/badge/works-offline-0B2A3C)

- Maps with coastlines. When a heatmap's rows and columns are latitude and longitude, it draws the Natural Earth coastlines and puts north at the top. Grids from 0 to 360 and from -180 to 180 both work, and so do regional grids.
- Play through time. The ▶ button next to a slider steps through time, or any other dimension, at the speed you pick. The colour range stays fixed while it plays, so you can compare the frames.
- Made for NetCDF and climate data. Dimension names, coordinates, `scale_factor`, `add_offset`, `_FillValue` and CF time units are applied for you, so you see 263.75 K on 2024-12-04 06:00, not `1500` at index 13. The noleap, 360_day and all_leap calendars work too.
- Big files stay fast. The file is read slice by slice in a background thread. In our test a 37 GB array opens, shows a page and draws a sampled heatmap in about one second, and a slow read is stopped after 20 s instead of freezing the editor.
- Plots you can use in a report. Choose from 8 colour maps (viridis, cividis, magma, inferno, plasma, turbo, gray and a diverging blue-red map), reverse them, set the range (2-98 percentile, min to max, symmetric around 0, from the `valid_range` or `actual_range` attribute, or your own numbers) and turn on a log scale. "Save PNG" writes the plot with its title, units, the slider positions and the colour bar.
- Click a point, get its time series. On a variable with 3 or more dimensions, a click on the heatmap plots that grid point along time (or another dimension you pick), with dates on the x axis, like ncview does. Save it as PNG or copy it as CSV.
- Remote SSH, WSL and dev containers: VS Code runs this extension on the machine that has the file, so a 40 GB file stays where it is and only the slice on screen is sent to your window.
- One viewer for HDF5, NetCDF-4 and NetCDF-3 (classic, 64-bit offset and CDF-5), including HDF5 files with other names such as Julia `.jld2`, MATLAB 7.3 `.mat` and `.loom`. Groups, attributes, compound tables, strings, chunking and compression filters are all shown. Nothing leaves your machine.

## Quick start

1. Install the extension.
2. Click a `.nc` or `.h5` file in the Explorer. Pick a variable on the left.

![A click on the .nc file shows the file overview. A click on t2m draws a heatmap, the time slider steps through 3 time steps, and the Table tab shows the values with latitude and longitude headers](https://raw.githubusercontent.com/theluckystrike/netcdf-viewer-vscode/main/images/demo-netcdf.gif)

*Recorded in the same window. The white arrow is drawn in to show where each click lands.*

## What you can do

- Browse the group tree with a filter box. Coordinates, plain datasets, external links and NetCDF dimensions have their own icons.
- Read the file overview (format, dimensions, global attributes and a table of all variables with units and long names), much like `ncdump -h`.
- See type, shape with dimension names, chunk shape, compression (shuffle, deflate level, LZF, szip and others by name), size in memory and the full attribute list. Internal HDF5 and NetCDF attributes are hidden behind a checkbox.
- Pick any two dimensions as rows and columns. Sliders fix the others and show the decoded coordinate value next to the index.
- Page through values 100 rows by 30 columns at a time, with coordinate values as row and column headers.
- Plot 1D data as a line and 2D slices as a heatmap with a colour bar and hover readout. Arrays larger than 512 x 512 are sampled with a stride.
- Read HDF5 files compressed with LZF, Blosc, bitshuffle, Zstd, LZ4, bzip2 or ZFP, as h5py, hdf5plugin and detector software write them, with no Python.
- See 8-bit RGB and RGBA images (height x width x 3 or 4, or HDF5 `CLASS=IMAGE`) as colour pictures, with the channel values under the mouse.
- Turn the coastlines on or off on latitude-longitude maps. They are drawn in the saved PNG too.
- Press ▶ next to any slider to play through that dimension. Pick the speed (0.5×, 1×, 2× or as fast as the file reads). Escape, a slider move or another variable stops it.
- Pick a colour map, reverse it, choose the colour range and a log scale. The colour map default is the setting `hdf5NetcdfExplorer.colormap`.
- Click a heatmap cell to plot the values at that point along time or another dimension. Escape closes the series.
- Save a heatmap, line plot or series as PNG with "Save PNG". The picture has a title with the variable, units and the slider positions, axis labels and the colour bar.
- See min, max, mean, std and the number of fill, NaN and Inf values for the slice on screen.
- Copy the path, or copy xarray or h5py code that loads the same slice.
- Export the slice on screen to CSV or JSON with "Export slice…". You get every row and column of the two chosen dimensions, with the coordinate values as headers. The sliders fix the other dimensions, and the JSON file records which index and value each of them had. Text from the file that starts with `=`, `+`, `-` or `@` gets a leading `'` in the CSV, so a spreadsheet does not run it as a formula.
- Turn CF decoding off to see the raw stored numbers.
- The view reloads when the file changes on disk, which helps while a model run is writing output. A script that deletes the file and writes it again also triggers a reload.

![An ERA5-style NetCDF-4 file in VS Code. The t2m variable is selected, with units, packing, chunks and compression, a time slider and a heatmap of 2 metre temperature](https://raw.githubusercontent.com/theluckystrike/netcdf-viewer-vscode/main/images/vscode-netcdf-t2m.png)

![The same variable as a paged table with latitude and longitude as headers](images/table.png)

## Supported files

| Format | How it is read |
|---|---|
| NetCDF-4 and NetCDF-4 classic (`.nc`, `.nc4`) | h5wasm (HDF5 2.0 compiled to WebAssembly) |
| HDF5 (`.h5`, `.hdf5`, `.he5`, `.hdf`, `.nxs`, `.h5ad`) | h5wasm |
| Compressed HDF5: deflate (gzip), shuffle, szip, fletcher32, n-bit, scale-offset, and the plugin filters LZF, Blosc, Blosc2, bitshuffle, LZ4, Zstd, bzip2 and ZFP (what h5py and hdf5plugin write) | h5wasm with the h5wasm-plugins libraries |
| HDF5-based formats (`.jld2`, `.loom`, `.h5mu`, `.hf5`, `.h5oina`, `.h5ebsd`, `.edaxh5`, `.oh5`, `.dream3d`, `.geoh5`, `.nde`, `.cxi`) | h5wasm, the same way as `.h5` |
| MATLAB 7.3 (`.mat`), or an HDF5 file with any other name | h5wasm. Right-click the file and pick "Open in HDF5 NetCDF Explorer", or use "Reopen Editor With…" |
| NetCDF-3 classic and 64-bit offset (`.nc`, `.cdf`) | netcdfjs parses the header, values are read by byte offset |
| NetCDF CDF-5, 64-bit data (`.nc` from PnetCDF, WRF, E3SM or `nccopy -k cdf5`), with the unsigned and 64-bit integer types | Our own header parser, values are read by byte offset |

The format is detected from the first bytes of the file, not from the extension, so a 512-byte user block (JLD2 and MATLAB 7.3 files have one) is fine. HDF4, NASA CDF and older MATLAB v5 `.mat` files get a clear message instead of an error. So does an HDF5 or NetCDF-4 file that was cut off during a copy or download: the message says how many bytes are missing.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `hdf5NetcdfExplorer.maxReadValues` | 1000000 | Largest number of values one read may return |
| `hdf5NetcdfExplorer.maxFileSizeMB` | 0 | Refuse files above this size, 0 means no limit |
| `hdf5NetcdfExplorer.readTimeoutSeconds` | 20 | Stop a read that takes longer and restart the reader |
| `hdf5NetcdfExplorer.colormap` | viridis | Colour map a heatmap starts with: viridis, cividis, magma, inferno, plasma, turbo, gray or coolwarm |
| `hdf5NetcdfExplorer.askForRating` | true | Ask for a rating after 2 files opened without an error in 2 sessions at least 4 hours apart. "Rate it" opens the Marketplace review page in VS Code and the Open VSX one in Cursor, Windsurf and VSCodium. "Later" asks one more time after 7 days, "No thanks" never again. It never asks after an error. Turn it off with `false`. |
| `hdf5NetcdfExplorer.showProFeatures` | true | Off: hide the Compare with… and Export subset… buttons and the Pro commands, so you see only the free viewer. With a Zovo Pro license they always show |
| `hdf5NetcdfExplorer.compareTolerance` | 0 | Compare two files (Pro): values that differ by this much or less count as equal, like `nccmp -T`. 0 means exact |

## Free and Zovo Pro

Everything this viewer did before 0.6.0 is free and stays free: every format, the tree, attributes, the table, plots and maps with coastlines, Play, time series, Save PNG and Export slice.

Two tools for professional work are part of Zovo Pro, and each has 3 free tries on your computer:

| Pro tool | What you get |
|---|---|
| Compare two files | Like nccmp. Lists variables that are in one file only, and changed shapes, types and attributes (global and per variable). Reads every value of every numeric variable that is in both files with the same shape, after CF decoding, so a packed file and its unpacked copy compare equal. Per variable: max and mean absolute difference, RMSE, how many values differ, fill and NaN mismatches and the index of the largest difference (for example `time=3, latitude=120, longitude=40`). Works across formats: NetCDF-4 against NetCDF-3, HDF5 against HDF5. The setting `hdf5NetcdfExplorer.compareTolerance` sets an absolute tolerance. The report has a filter and saves as CSV, Markdown or JSON. |
| Export a subset | Like `ncks -d` or xarray `.sel`. Pick a variable, then a range for each dimension: all, an index (`5`, `-1` for the last), indices (`0:99`, `0:99:2`), values of the coordinate (`30..60`) or dates on a time axis (`2023-08-01..2023-08-31`). The box shows what you selected as you type. Save it as NetCDF (NetCDF-3 64-bit offset, with the coordinates, the attributes and a `history` line; xarray, CDO, NCO, Panoply and ncview open it) or as a tidy CSV with one row per point and the coordinates in the first columns. Values are written decoded (scale and offset applied), with NaN as the fill value. |

Start them with the "Compare with…" button at the top of the viewer, the "Export subset…" button next to "Export slice…", the Command Palette, or the Explorer menu (select two files to compare). A notification shows the progress, and Cancel stops a long run without leaving a half-written file.

### Getting Pro

Zovo Pro is USD 19 once, on GitHub Sponsors (the ["$19 one time" tier](https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878)) or by PayPal, and it unlocks the Pro features in every Zovo VS Code viewer: this one, [Hex Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-hex-viewer), [DOCX Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode), [NumPy Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) and the ones that get Pro features later. See [what Zovo Pro includes](https://theluckystrike.github.io/zovo-plugin-factory/pro.html).

- "Get Zovo Pro" (in the message after the free tries, or the command "NetCDF Viewer: Get Zovo Pro") opens the Zovo Pro tier on GitHub Sponsors in your browser.
- Then run "NetCDF Viewer: Unlock Zovo Pro with GitHub Sponsors". VS Code asks you to sign in with GitHub, and the viewer asks GitHub one question: has this account bought the Zovo Pro tier? A monthly sponsorship of USD 10 or more that is still running counts too. The "$15 one time" and "$5 a month" tiers on the same page are for Obsidian plugins and do not include Zovo Pro.
- No GitHub account? Send USD 19 to [paypal.com/paypalme/najzzz/19](https://www.paypal.com/paypalme/najzzz/19) with "Zovo Pro" in the note, and you get a license key by email within a day.
- A license key starts with `ZOVO1.`. Paste it with "NetCDF Viewer: Enter Zovo Pro License Key". It is checked on your computer and kept in VS Code's secret storage. "NetCDF Viewer: Remove Zovo Pro from This Editor" removes it.

Nothing about Pro shows up on its own: no popup when a file opens, no counter, no reminder. The two buttons carry a small PRO label, and a Pro tool explains itself only when you click it after its free tries. `hdf5NetcdfExplorer.showProFeatures: false` hides the buttons and commands.

## Privacy and safety

The extension has no telemetry and makes no network calls, except one call to GitHub when you choose "Unlock Zovo Pro with GitHub Sponsors" (a monthly sponsor gets one silent recheck every 30 days). A license key is checked on your computer, and "Get Zovo Pro" opens a page in your browser. The Pro tools only read your files and write only the new file you pick. It never runs code from a file. Values go to the view as plain JSON and are drawn as text or canvas pixels, under a strict Content Security Policy with no remote scripts.

## Known limits

- Files must be on a disk that the extension can read: your computer, or the remote machine in a Remote SSH, WSL or dev container window. Virtual file systems, such as GitHub repositories opened in vscode.dev, are not supported.
- Other HDF5 filters (SZ, JPEG and rarer plugins) are named in the dataset details, and reading such a dataset shows a message instead of values.
- Zarr is not supported yet.
- MATLAB `.mat` files saved in the v5 format are not HDF5. Save them again with `save(filename, '-v7.3')`.
- Export writes at most `hdf5NetcdfExplorer.maxReadValues` values (1,000,000 by default) per file.
- The colour maps other than viridis are blended from 2 to 15 anchor colours, so they are close to the matplotlib maps but not identical.
- Coastlines are drawn on regular or near-regular latitude-longitude grids (1D coordinates). Curvilinear grids with 2D latitude and longitude arrays (many ocean models) and projected grids in metres get no coastlines yet.
- The colour range and saved heatmap PNG use the cells on screen, which are sampled to at most 512 x 512 for big arrays. Saved pictures are dark text on white, whatever the editor theme.
- A point series needs a numeric variable with 3 or more dimensions. Above 100,000 points it takes every Nth value and says so.
- The standard calendar uses the proleptic Gregorian calendar for dates before 1582.

## Credits

Coastlines: [Natural Earth](https://www.naturalearthdata.com/) 1:110m, public domain. Compression filters: [h5wasm-plugins](https://github.com/h5wasm/h5wasm-plugins) (the HDF Group plugins built to WebAssembly). HDF5 reading uses [h5wasm](https://github.com/usnistgov/h5wasm) by the National Institute of Standards and Technology, which bundles the HDF5 library by The HDF Group. NetCDF-3 headers are parsed with [netcdfjs](https://github.com/cheminfo/netcdfjs) (MIT). See `THIRD-PARTY-NOTICES.txt`.

## License

MIT

## Support Zovo

Zovo extensions are free, with no ads and no tracking. They are made by [theluckystrike](https://github.com/theluckystrike) on GitHub. If this one saves you time, you can support the work:

- [Sponsor on GitHub](https://github.com/sponsors/theluckystrike)
- [PayPal](https://www.paypal.com/paypalme/najzzz)
- [Follow theluckystrike on GitHub](https://github.com/theluckystrike)

## More tools by Zovo

- [NPZ Viewer & NPY Viewer, PyTorch, GGUF & Safetensors (NumPy Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) shows NPY, NPZ, Safetensors and GGUF tensors with stats and heatmaps.
- [Pickle Viewer & PKL Viewer (No Python)](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-pickle-viewer) opens Python pickle files without Python and never runs their code.
- [GeoJSON Viewer, KML Viewer & GPX Viewer (Map Preview, Shapefile)](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-geo-map-viewer) GeoJSON viewer, KML viewer and GPX viewer with a map preview in VS Code. Also opens shapefiles (SHP, zipped), KMZ, TopoJSON, WKT and CSV with lat/lon: feature table, properties, GPX distance and elevation profile, reprojection from .prj, PNG export. Free, no sign-in, works offline.
- [TIFF Viewer & TIF Viewer (16-bit, GeoTIFF)](https://marketplace.visualstudio.com/items?itemName=zovo.tiff-viewer) opens 16-bit, float, multi-page and GeoTIFF images.
- [DICOM Viewer, MRI Viewer & CT Viewer (NIfTI)](https://marketplace.visualstudio.com/items?itemName=zovo.dicom-nifti-viewer) opens CT and MRI scans, DICOM folders and NIfTI volumes with window presets and three views.

See [all Zovo extensions on the Marketplace](https://marketplace.visualstudio.com/publishers/zovo).
