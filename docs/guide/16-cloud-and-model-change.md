# Point cloud and 3D model change

Two point clouds of the same site show, point by point, how far the later survey is from the earlier one: a moved pipe, a new object, a dent. Two 3D models with tagged parts show which parts are new, gone, moved or changed. Both run on this computer as jobs and add new layers. Your own layers are never changed.

## Run cloud change

Each date needs a point cloud of its own, in COPC. Convert LAS or LAZ first with the **Point cloud to COPC** job (see [Run a job](08-building-projects.md#run-a-job)).

1. Open the **Changes** tab (see [Show changes](14-changes.md#show-changes)) and pick the two dates.
2. Click **Run cloud change**. The job shows in **Jobs** while it runs.
3. When it finishes:
   - a layer "Cloud change ... to ..." is added: the later cloud with the distance of each point to the earlier cloud;
   - the clouds are coloured by **Change**;
   - each changed area is listed in the **Changes** tab, for example "New or moved here: 12.4 m², up to 0.84 m", "Gone or moved away" or "Changed surface".

Points closer than 5 cm to the earlier cloud count as unchanged. A moved object shows twice: where it is now, and where it was.

Before the long work, {product} checks that the two clouds line up where nothing changed. When they are more than 5 cm apart, it stops: "The dates are not aligned: the clouds are ... m apart where nothing changed ... Align the clouds (for example to the survey control) and run the comparison again." It compares only where both clouds have points.

## Colour by change

1. Click **Point cloud** in the stage toolbar.
2. In **Colour by**, click **Change**. It is offered once a project has a cloud change layer.

The legend under the 3D view reads "Change: distance to the earlier date":

- The colour ramp runs from grey (unchanged) through amber to red, for example 0.00 m, 0.15 m and 0.30 m.
- **Hide changes under**: drag the slider to hide points that moved less than the value, so only real change is left.
- Point at the cloud: "Under the pointer: 0.12 m". This works in the main 3D view.

On the demo, the moved pump skid and the new shelter show warm; the tanks stay grey.

## Volume change in the legend

The legend also shows **Volume change, same dates**: "Fill ... m³, cut ... m³, net ... m³" for the two dates.

If it reads "No volume change for these dates yet.", click **Run volume change**. It runs a surface change on the two clouds (see [Run surface change](15-imagery-and-surface-change.md#run-surface-change)) and the totals show when it finishes.

## Run model change

Each date needs a 3D model with tagged parts, for example tanks T-201 to T-203.

1. In the **Changes** tab, click **Run model change**.
2. When it finishes, each part is listed under **Model parts**:
   - **Added**: "... is new";
   - **Removed**: "... is gone";
   - **Moved**: "... moved 3.35 m";
   - **Changed**: the surface moved in place, for example "T-202 changed: up to 0.15 m" for a dent.
3. A hidden layer "Model change ... to ..." is added: the later model coloured by how far its surface is from the earlier one. Show it in **Datasets**.

## In a package

A package opened read-only shows the change layers and the colours. Comparisons run only in a project folder: the legend says "Volume change is computed in the project folder, not in a package." and offers no button.
