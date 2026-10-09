"""Survey export writers (M11 G7): LandXML, 12da, DXF, SHP, KML/KMZ, CSV, GeoJSON, GeoTIFF, LAS/LAZ.

``frame.py`` settles where the numbers go (the site grid through G1's one PROJ pipeline, WGS 84 or
an EPSG code, in metres or feet) and what every file states about it; the writers take
coordinates already in the output frame and units and never transform anything themselves.
"""
