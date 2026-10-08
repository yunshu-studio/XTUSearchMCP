# 湘潭大学教学机构站点适配矩阵

调研日期：2026-10-08。来源为湘潭大学“教学机构”页面列出的站点，并对各站首页搜索表单与一次真实关键词搜索进行探测。

## 适配器总类

- `vsb_lucene`：VisualSiteBuilder/Lucene 表单搜索。自动读取 `form[action]`、`wbtreeid`、`searchScope` 和其他 hidden 参数，不再猜固定 URL。
- `business_jsp`：商学院自定义 JSP 搜索，`index.jsp?cc=cindex&cd=search&searchword=...`。
- `crawl`：首页未发现兼容原生搜索，但存在可抓取 `/info/...` 文章；由 Queue + D1/R2/Vectorize 提供检索。
- `employment`：就业网专用 `dc.bysjy.com.cn/search/provider_new` API。

## 教学机构站点

| ID | 站点 | 类型 | 搜索入口 | wbtreeid | scope | 结果模板 |
|---|---|---|---|---:|---:|---|
| bqsy | 碧泉书院 | vsb_lucene | `searchResult.jsp` | 1001 | 0 | listg2412 |
| business | 商学院 | business_jsp | `index.jsp?cc=cindex&cd=search` | - | - | business_searchlist |
| glxy | 公共管理学院 | vsb_lucene | `ssjg.jsp` | 1001 | 0 | listg2412 |
| fxxb | 法学学部 | vsb_lucene | `v24_list_search.jsp` | 1001 | 0 | v24_list_ul_box |
| law | 法学院 | vsb_lucene | `v24_list_search.jsp` | 1001 | 0 | v24_list_ul_box |
| ipf | 知识产权学院 | vsb_lucene | `ssjg.jsp` | 1001 | 0 | listg2412 |
| xyfxgl | 信用风险管理学院 | vsb_lucene | `search.jsp` | 1001 | 0 | listg2412 |
| mks | 马克思主义学院 | vsb_lucene | `ssjg.jsp` | 1001 | 0 | listg2412 |
| wxy | 文学与新闻学院 | vsb_lucene | `v26_list_search.jsp` | 1001 | 0 | v26_result_list |
| wgyxy | 外国语学院 | vsb_lucene | `ssjgy.jsp` | 1001 | 1 | ssjgy_list_box |
| art | 艺术学院 | vsb_lucene | `search.jsp` | 1001 | 1 | listFrame |
| math | 数学与计算科学学院 | crawl | - | - | - | crawl_index |
| ai | 人工智能学院 | vsb_lucene | `ssjgy.jsp` | 1001 | 0 | listFrame |
| wlxy | 物理与光电工程学院 | vsb_lucene | `ssjgy.jsp` | 1001 | 0 | listg2412 |
| hxxy | 化学学院 | crawl | - | - | - | crawl_index |
| clxy | 材料科学与工程学院 | vsb_lucene | `ssjg.jsp` | 1001 | 0 | listg2412 |
| hgxy | 化工学院 | vsb_lucene | `ssjg.jsp` | 1002 | 0 | listg2412 |
| hjzy | 环境与资源学院 | vsb_lucene | `search.jsp` | 1001 | 0 | listFrame |
| jxgc | 机械工程与力学学院 | vsb_lucene | `search.jsp` | 1001 | 0 | listFrame |
| aei | 自动化与电子信息学院 | vsb_lucene | `ssjg.jsp` | 1001 | 0 | listg2412 |
| jwxy | 计算机学院·网络空间安全学院 | vsb_lucene | `search.jsp` | 1001 | 0 | listg2412 |
| cem | 土木工程学院 | vsb_lucene | `seach.jsp` | 1001 | 0 | listg2412 |
| gjjl | 国际交流学院 | vsb_lucene | `ssjg.jsp` | 1001 | 0 | listg2412 |
| cyxy | 创业学院 | vsb_lucene | `search.jsp` | 1001 | 0 | listFrame |
| tyb | 体育教学部 | vsb_lucene | `search.jsp` | 1001 | 1 | listFrame |
| etc | 工程训练中心/教学部 | crawl | - | - | - | crawl_index |
| jxjyxy | 继续教育学院 | vsb_lucene | `ssjg.jsp` | 1001 | 0 | listg2412 |
| xxxy | 兴湘学院 | vsb_lucene | `ssjg.jsp` | 1080 | 0 | listg2412 |

## 已知特殊情况

- `fxxb.xtu.edu.cn` 与 `law.xtu.edu.cn` 在本轮探测时首页 HTML 完全一致，后续可以做 canonical/alias 去重；v2.3 先保留 `alias_of` 数据列，不自动合并。
- 材料学院真实首页搜索表单是 `ssjg.jsp?wbtreeid=1001`，不是此前猜测的 1021。
- 土木工程学院真实文件名就是 `seach.jsp`，不能靠固定候选列表猜。
- 无原生搜索并不视为校验失败；只要能探测到文章链接，就归入 `crawl`。
