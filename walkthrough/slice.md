# Slice, page and plot

- "Rows" and "Columns" pick the two dimensions you look at. Sliders fix the others (for example `time`). The slider label shows the decoded date.
- "Table" shows 100 x 30 values per page. Use the arrows to move.
- "Plot" draws a line for 1D data and a heatmap for 2D data. Big arrays are sampled to about 512 x 512 points.
- "Apply CF decoding" applies `scale_factor`, `add_offset` and `_FillValue`, and turns time numbers into dates.
- "Copy xarray code" or "Copy h5py code" copies Python that loads the same slice.
