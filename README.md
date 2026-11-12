# 初光 First Light

日出前的最后几秒：一面镜子一样的湖，湖心小岛上一棵开满花的树。太阳从远山的缺口露出第一线光，花被逆光一点点照透。

线上地址：https://first-light-ruby.vercel.app

整个画面是用 three.js 实时渲染的 3D 场景，没有用任何图片或模型文件：

- 树是程序生成的枝干，上面有四万多朵五瓣花
- 水面是实时镜面反射，花瓣落到近处会荡开涟漪
- 前 5 秒是一段完整的日出，之后场景会一直运行
- 移动鼠标（手机上按住拖动）可以轻轻转动视角

## 本地运行

```bash
npm install
npm run preview
```

`npm run build` 会把 `src/main.js` 和 three.js 打包成 `public/app.js`，并把 `index.html` 复制到 `public/`。`public/` 就是可以直接部署的静态站点。

## 文件

- `index.html`：页面、标题和控制按钮
- `src/main.js`：全部场景代码（天空、山、树、花、水面、后期处理和时间线）
- `vercel.json`：Vercel 的构建设置

## 操作

- 空格：暂停 / 继续
- R：重播
- 右下角按钮：重播、暂停、全屏
