# Models from drawings and point clouds

The **Model builder** makes a 3D model with tagged parts from a plot plan drawing, from a point cloud, or both: tanks and vessels, buildings, boxes such as skids and racks, and pipes. Every part starts as a draft. Only the parts you accept go into the model.

Everything runs on this computer.

## Open the model builder

1. Open the project on **Scene**.
2. Press **Ctrl K**, type "model" and pick **Open the model builder**.

The panel opens beside the 3D view. **Close** closes it; your parts are kept.

## Import a drawing

{product} reads DXF drawings. DWG is not supported: save the drawing as DXF first.

1. Under **Parts come from**, click **Import drawing (DXF)**.
2. Click **Choose** and pick the DXF file, or type its path.
3. In **Drawing units**, keep **As the file says**, or pick the units the drawing uses (**Millimetres**, **Centimetres**, **Metres**, **Inches**, **Feet** or **US survey feet**).
4. Click **Import**. "The drawing is imported. Its plan is on the site and its parts can be added."

A drawing with no units stops with a message to set the drawing units and import again. On the demo, try `sources/plot-plan-unitless.dxf` to see it, then `sources/plot-plan.dxf`.

## Place the drawing by points

If the plan does not sit on the site, place it by points:

1. Pick the drawing and click **Place by points**.
2. Click **Pick on the plan** and click a sharp point on the plan (or type its x y in drawing units).
3. Click **Pick on the site** and click the same point on the ortho, the model or the ground (or type easting northing, or latitude, longitude).
4. Do the same for at least one more point, far from the first. Each pair shows in the table; **Remove** drops one.
5. Click **Place the drawing**.

## Parts from the drawing

Pick the drawing and click **From drawing**. Tanks with their tags, buildings with their heights, boxes and pipes come in as drafts, for example "12 draft parts from the drawing."

## Parts from a point cloud

Pick a point cloud and click **From point cloud**. {product} fits tanks, boxes, buildings and pipes to the points as a job, for example "4 draft parts fitted. Accept or reject them."

Each fitted part says how far the points are from it ("Fitted, 1.2 cm off") with a dot: green up to 2 cm, amber up to 5 cm, red above.

## Check and accept the parts

The **Parts** list shows each part with its tag, kind, size and where it came from, and counts the accepted parts and the drafts.

- **Accept** or **Reject** a part, or **Accept all drafts** and **Reject all drafts**.
- With the list focused: the arrow keys move, **A** accepts, **R** rejects, **D** makes a part a draft again, **Shift A** accepts all.
- Select a part to edit its **Tag**, **Name**, position (**East (x)**, **Base height (y)**, **South (z)**) and sizes such as **Radius**, **Height**, **Roof height**, **Length**, **Width**, **Turn** and **Diameter**. Press **Enter** to keep a value.

## Build the model

- **Preview drafts** shows every part that is not rejected in the 3D view, as a draft.
- **Build model** builds the accepted parts: "The model is built. It is in the 3D view."

The built model is an ordinary 3D layer with one tagged part per part, so clicking a tank selects it by its tag. Draft previews are left out of reports and packages.

## Let the agent help

While the model builder is open, the agent works on the **Build from drawings** route (see [Which model does what](07-ai-agent.md#which-model-does-what)). Ask, for example, "Build the tank T-201 from the drawing" or "Fit the tanks in the point cloud".

The agent lists parts, proposes and fits draft parts, edits them and builds the model. Each of these steps waits for **Approve** or **Reject**. Its parts are drafts like any other, and you accept them in the panel.

## Allow cloud AI for drawings

Plan images and drawings stay on this computer unless the project allows otherwise. **Allow cloud AI for drawings** at the bottom of the panel is off by default for every project.

- **Off**: a cloud model on the **Build from drawings** route sees only part ids, kinds and states. It cannot look at the plan, and it does not get tags or sizes from the drawing.
- **On**: the agent may send plan images and drawing content to the cloud model. The send preview still shows what leaves before it goes (see [What is sent and when](07-ai-agent.md#what-is-sent-and-when)).

A local model can always read the drawings, because nothing leaves this computer (see [Set up a local model](20-local-model.md)).

## In a package

A package opened read-only shows its models: "This project is a read-only package: models can be looked at only."
