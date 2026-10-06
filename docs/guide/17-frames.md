# Same view on another date

The **Frames** pane shows a video frame or a photo of one survey date beside the view of another date taken from about the same place. {product} finds the pair from the camera positions, so you can look at the same spot on both surveys without searching.

The project needs two survey dates, and video with a flight log or photos with camera positions on both.

## Open the Frames pane

Any of these opens it:

- In the video window, click **Same view on the other date** (the clock button in its title bar).
- On a photo in a **Photos** pane, click **Same view on the other date**.
- In **Split**, set **Left side shows** or **Right side shows** to **Frames**.

The pane shows the frame or photo you came from on the left and the matching view of the other date on the right. The line above them says how close the two cameras were, for example "1.3 m, 2 degrees apart".

## Follow a clip or step through photos

- Play or scrub the clip: the other date's frame follows. It shows still frames that move along with the clip; it does not play a second video.
- With photos, **Previous photo** and **Next photo** step through the photos and keep the pairs.
- With more than two dates, pick the other date in **Compare with**.

If no view of the other date is near, the pane says "No view of ... near this one." A photo without a camera position cannot be matched.

## Swipe, blend and line up

Above the frames, pick how to compare them:

- **Side by side**: the two frames next to each other.
- **Swipe**: one frame over the other, with a handle to drag between the dates.
- **Blend**: the other date fades over the first. Set the **Blend amount** with the slider.

In **Swipe** and **Blend**, **Line up the ground** turns the other frame so the ground lines up, from the two camera poses. Roads and markings then match across the handle. Tall objects still lean differently, because the ground is taken as flat.

## Find changes in matched frames

1. Open the **Changes** tab (see [Show changes](14-changes.md#show-changes)) and pick the two dates.
2. Click **Find changes in matched frames**. It pairs the photos of the two dates by camera position and compares the pairs in a job.
3. When it finishes, the changes it found are draft detections on the later date's photos, labelled "change". They are also listed in the **Changes** tab under **Frames**.
4. Review them on **Detections** like any other detection (see [Review detections](08-building-projects.md#review-detections)).

It needs photos with camera positions on both dates ("Both dates need photos with camera positions."). Video frames are not compared.
