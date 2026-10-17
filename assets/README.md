# 看板娘與 icon 素材

[無字看板娘](mascot.png) · [背景](source/background.png) · [512 px AppIcon](icon.png) · [256 px AppIcon](icon-256.png) · [完整 ComfyUI workflow](source/workflow.json) · [文字排版 workflow](source/lettering-workflow.json) · [AppIcon workflow](source/icon-workflow.json)

保留薄荷青、薰衣草紫與暖金色的「閘道接待員」，搭配像素遊戲構圖與粗輪廓卡通風格的地下 API 匯流中心：高柱大廳、紅磚水道，以及交錯轉彎、分岔匯流的綠色水管。人物與背景採用一致的色塊與輪廓；定稿標題使用珊瑚粉、奶油金、深藍粗框與奶油色外框，放大後置於畫面中央偏左，兩行沿同一中線對齊。背景空間參考使用者提供的地下水道照片，場景元素參考《超級瑪莉歐兄弟》的水管與紅磚風格。

圖片透過 ComfyUI MCP 在本機生成與合成。workflow 包含完整提示詞、Anima Preview 3 模型設定、背景重繪 seed（2026101705、denoise 0.72）、人物合成、標題排版與 icon 裁切，沒有付費 API 節點。平台與背景一起重繪，避免保留裁貼接縫。重跑前，先用 MCP 的 `upload_file` 上傳 [背景原圖](source/background-source.png)、[人物原圖](source/character-source.png)、[人物遮罩](source/character-mask.png)、[AppIcon 人物原圖](source/icon-character-source.png)、[AppIcon 人物遮罩](source/icon-character-mask.png)、[AppIcon 圓角遮罩](source/icon-mask.png) 與 [內框遮罩](source/icon-content-mask.png)，保留檔名，再以 `run_workflow` 執行。人物沿用已確認的原圖（原始生成 seed：2026101701）。

僅調整文字時，上傳 `mascot.png` 並執行文字排版 workflow 即可，無須重新生成背景與人物。定稿文字配色為 `#FFA6AB`／`#FFE4A3`，外框為 `#172D50`／`#FFF2D1`；遮罩向外擴張 15／23 px。

AppIcon 為透明圓角 PNG，搭配深藍近黑色外框；人物放大並改為比 Ya 的 V 手勢，上方「AG」沿用 banner 的配色與雙層描邊。手勢以 Anima 局部重繪後修整手指與手腕（修整 seed 2026101742、denoise 0.55；[提示詞與參數](source/icon-pose-prompt.txt)），金色袖口配色取自 `character-source.png`。人物從原圖合成後輕微銳化，保留線條清晰度。獨立重跑 AppIcon workflow 時，上傳 `background.png`、`icon-character-source.png`、`icon-character-mask.png`、`icon-mask.png` 與 `icon-content-mask.png`，即可重做 512／256 px 圖示。

風格參考：`references/agent-switch/README.md`、`docs/mascot.png` 與 `packaging/appimage/agent-switch.svg`（agent-switch commit `007a4a9bbe87aa299822dc372b2e548a54c0a6a2`）。生成環境：ComfyUI 0.41.2、comfy-cli 1.22.0；工作流範本：`image_anima_preview`（templates 0.11.86）。
