## 介绍

这个工具先用js脚本将直播弹幕xml文件简化为内容更少的纯文本文件，用于丢入ai工具进行总结。

## 步骤

1. 把弹幕xml放进source/source.xml
2. 使用src/utils/do_danmaku_to_simple.js
3. 获得source/output.txt，拿去给ai总结

prompt可参考：
```
根据直播弹幕记录来描述直播内容，做成直播repo，让没看这场直播的人也能了解直播内容和有趣的部分。按照时间顺序描述直播中的各个直播内容，对其中观众反应强烈的、有趣的点重点描写。
```

（下面不用看）

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
