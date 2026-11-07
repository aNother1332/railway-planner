# Hand-drawn railway illustration assets

Generated with the built-in image_gen tool, 2026-10-18. Two independent 1536 × 1024 PNG layers, stored locally. The transparent train is positioned and scaled in CSS independently of the landscape. These are original generated illustrations of a plausible Chinese railway scene, not photographs documenting a named place.

## railway-landscape.png

Prompt: Create a finished website background illustration, very wide landscape composition 3:2 ratio, high resolution. Delicate hand-drawn graphite and blue ink linework with translucent pale watercolor washes on luminous off-white cold-pressed paper. A physically plausible real-world Chinese high-speed railway landscape in Jiangnan countryside: a double-track concrete viaduct curves gently across the lower third, from left foreground toward right middle distance. Slightly elevated hillside viewpoint. Accurate rails, sleepers, concrete parapets, slender catenary poles and overhead wires. No train: leave the track empty for an independent train overlay. Mist-blue mountains, lightly sketched trees, light sage rice fields, winding river, white-walled tiled-roof village houses. Soft daylight, powder blue, pale periwinkle, very light fresh green, fine natural gray pencil marks. Rich detail on the right and lower half, quiet nearly white sky above. Refined architectural travel sketchbook, imperfect hand-drawn contours and cross-hatching. No gold, dark green, teal, sepia, text, logos, watermark or website mockup.

## harmony-train.png (previous version, retained as source backup)

Prompt: Create only a transparent train overlay using the landscape as perspective, positioning and hand-drawn style reference. Same 1536 × 1024 canvas, with true transparent empty margins. No landscape, tracks, poles, sky, paper rectangle or background. One Chinese CRH380A Harmony-style high-speed EMU, white body, slender cool blue stripe, aerodynamic silver-white nose, dark wraparound windscreen, realistic windows and three connected cars. Fine graphite/blue pen contours and pale watercolor shading matching the landscape. Nose faces right, shallow upward-right railway perspective from a slightly elevated hillside. Keep a smooth coherent silhouette, no ground shadow, no text, logos or lettering. Preserve transparency. Requested position was near the foreground track; the final generated layer required CSS scale/rotation/translation to align with that track.

## Integration

Run `python tools/embed_rail_art.py` after replacing either PNG. The page embeds the local PNG data so the running standard-library server does not need new static routes or a restart. CSS controls the fixed alignment, and JS moves only the train carrier within eight screen pixels along the straight railway tangent, in addition to shared background parallax of up to four horizontal and two vertical screen pixels. Touch, reduced-motion, blur and hidden-tab handling preserve a stationary accessible fallback.


## harmony-train-complete.png (previous curved version)

Generated with built-in image_gen from the railway landscape as reference. First create a composite with a complete eight-car Chinese Harmony-style EMU on the near track: a larger streamlined front on the lower left, all connected cars receding smaller toward the upper right following the existing railway curve, a complete smaller rear cab, realistic roof/side viewpoint, cool-blue stripe and pale watercolor pencil style. Preserve the landscape, viaduct and track alignment; every bogie must contact the same track. No text or logos.

Second extraction prompt: extract the complete train to a truly transparent 1536×1024 PNG, retaining front nose, all cars and rear cab, removing all sky, tracks, catenary, wires, buildings, vegetation and ground, with no cropped ends. The output framing differed from the composite; CSS therefore calibrates scale, rotation and translation against the original railway. The new active asset requires a 3-degree rotation, 0.56 scale and a fixed percentage translation, rather than the previous opposite-facing train's -6-degree alignment. These fixed transforms are separate from interactive motion.

The background and train share the same slightly overscanned 3:2 canvas, preserving their registration across viewport sizes. The additional train motion projects pointer position onto the railway tangent; a common easing clock keeps background and train layers synchronized. Blur, resize, hidden tab and reduced-motion changes reset both layers.


## harmony-train-straight.png (active version)

Built-in image_gen prompt: Production transparent PNG, 1536×1024. Draw one complete straight Chinese Harmony-style high-speed train with eight connected cars and both streamlined end cabs. Front on left and larger, rear on right and modestly smaller. All wheel/bogie contact points on the same horizontal baseline, no curvature, winding tail or bent couplings. Perspective narrowing comes from the roof/windows converging gently toward the right and gradually reducing car dimensions; wheel contacts stay collinear. Elevated three-quarter view, pale silver-white body, cool blue stripe, fine gray-blue pencil contours, pale watercolor shading. Preserve clear margins and genuine transparency; no scenery, tracks, paper, halo, text or logos. It will be scaled down and rotated onto a short straight track segment.

The result is registered using train-alignment.json and the actual visible wheel contacts. It is about forty percent shorter on screen than the preceding curved train. All cars remain before the background bend. This version uses 0.33 scale and a rotation derived from the straight wheel-contact baseline and rail slope −0.2; pointer travel follows that same slope and is limited to 8px beyond shared scenery motion. The embed script selects this file.
