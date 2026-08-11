# Semantic taxonomy

Use one coarse category for every component. Add a short `subtype` only when the
visual evidence supports it.

| Category | Scope |
|---|---|
| `skin` | Visible body skin not better described as a face detail |
| `face` | General face region |
| `eye` | Eyes, pupils, and eye highlights |
| `mouth` | Mouth and lip pixels |
| `face_detail` | Brows, blush, nose, markings, and other facial details |
| `hair` | Hair, bangs, ponytails, and beard-like hair |
| `head_accessory` | Hats, ears, horns, crowns, and hair ornaments |
| `face_accessory` | Glasses, masks, eyepatches, and face jewelry |
| `upper_clothing` | Shirts, jackets, bodices, and torso clothing |
| `lower_clothing` | Trousers, shorts, and skirts |
| `one_piece_clothing` | Dresses, robes, and other continuous outfits |
| `sleeve` | Sleeves distinguishable from their upper garment |
| `glove` | Gloves and hand coverings |
| `legwear` | Socks, stockings, and leg coverings |
| `shoe` | Shoes, boots, and footwear |
| `neck_accessory` | Ties, scarves, collars, and necklaces |
| `body_accessory` | Torso decorations and carried body items |
| `waist_accessory` | Belts, sashes, and waist decorations |
| `arm_accessory` | Bracelets, armbands, and arm decorations |
| `leg_accessory` | Garters and leg decorations |
| `back_accessory` | Capes, wings, backpacks, and back items |
| `other_accessory` | Supported accessory that fits no category above |
| `unknown` | Semantically uncertain content |

Use stable lowercase instance IDs such as `hair.main` or `outfit.glove.left`.
One component may span multiple body parts and Base/Outer surfaces.
