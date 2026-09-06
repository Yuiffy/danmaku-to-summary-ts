"""Prompt templates and identity/reference presentation. No provider or config IO."""
from typing import Any, Dict, Optional


COMMON_IMAGE_EVIDENCE_PROMPT_RULES = """【统一视觉证据规则（四格与沉浸式共用）】
- 两种画风使用同一套参考图事实链：人物参考图只决定人物外观；脚本请求的直播截图决定本场画面中真正可见的作品、游戏、人物、道具、数量、界面、动作与结果，不要把参考图当作装饰。
- 游戏、电影、动画或电视剧类内容，游戏/影视截图是视觉主证据；若截图清楚显示标题、Logo、UI、作品画面或关键道具，优先按截图还原；若截图只是直播间画面、黑屏、加载、转场、遮挡或没有显示目标界面，不能凭孤立词、题材、角色设定或模型常识补出具体游戏、战舰、Logo、UI或角色；但同场结构化 games 已明确确认的游戏名可以作为活动身份使用，只能把未显示的细节保持中性。
- 当直播事实、脚本候选名称和截图互相冲突时：截图中清楚可见的作品标题/Logo、游戏或影视画面和UI，优先于ASR对作品名的猜测；明确语音与同场结构化 games 决定主播确实做过什么，截图决定输入图中可见的作品视觉身份；证据不足时使用中性游戏/屏幕画面，不强行指定作品。
- selectionMode=script_requested 的图片是脚本指定时间点的高清独立帧；同一请求的多张独立帧共同服务一个用途，不要机械画成多个分格。selectionMode=script_requested_sheet 的图片是同一用途的多时间点宫格，各格可能是候选画面、不同角度或事件过程；逐格只提取实际可见且与用途相关的事实，不要求全部画入成品。
- 参考图是事实核对和构图素材，不是最终构图模板；四格也要按自身剪贴画风格重新组织，不要照抄直播软件边框、弹幕瀑布、主播坐姿，也不要把 JSON 字段、时间戳或参考记录画进成品。"""


IMMERSIVE_IMAGE_PROMPT_RULES = """【沉浸式画面策略（必须执行）】
- 不要画成规则的2x2四宫格、编号面板或四块等大的直播截图复述。优先一张有主次关系的电影感主画面；需要多个事件时，用不对称蒙太奇、前中后景或连续动作自然串联。
- 沉浸式内容可以让房间主人进入已确认的作品环境，与对应动作和道具互动，但不要因为“沉浸式”就把作品画面替换成泛化的豪宅、森林或舞台。房间主人可以参与动作，但不能遮住或取代作品的识别性画面。
- 只限制直播软件桌面：整张图最多允许一个小区域出现直播桌面（仅指直播软件边框、弹幕或主播窗口）；游戏/影视本身的画面、标题画面、解谜界面和字幕不受此限制，必要时应保留为大面积主场景。
- 未来计划、假设、脑补、梦境或转述故事不是本场已经发生的事实。必须用想象气泡、幻想小剧场、Q版分身、梦境边框等视觉语法明确区分，不能画成主播当场真的抵达或经历了该事件。
- 保留主播参考图中的脸、发色、瞳色、兔耳/配饰等身份特征；“进入作品世界”只改变环境、动作与合适的服装，不要把主播直接替换成作品角色。
- 保持大幅人物插画和电影感主画面为视觉中心，同时必须落实漫画脚本的 textPlan：清晰绘制4~6处中文“回忆锚点”，总字数约24~60字。至少一处是本场有辨识度的原话、吐槽或梗，其余分别点明不同场景的具体事件或结果，让观众一眼能回忆本场内容。
- textPlan 中的文字必须逐字使用，不擅自改写、合并或补充无来源内容。每处通常2~14字，使用短台词框、手写旁注、道具标签、冲击字幕或环境字，紧邻它所说明的人物、动作或场景；不要把全部文字堆成底部摘要、节目单、规则四格标题或一个遮挡人物的超大海报标题。
- 文字要有主次层级：代表性原话/梗可作为中等字号视觉焦点，其余事件锚点用较小字号分散在对应场景；保证中文完整、清晰、高对比且不遮挡脸、手、关键角色或关键道具。不要把直播摘要逐句抄进画面。
"""


COMIC_ARTIST_PROMPT_TEMPLATE = """你作为虚拟主播二创画师大手子，根据直播内容，绘制直播总结插画。
角色描述：{character_desc}。
{identity_context}。
{live_context}
风格：多个剪贴画风格分镜（2~4个吧），每个是一个片段场景，
默认以画面叙事为主，但如果有助于漫画效果，可以设计少量中文台词框、拟声词、标题字或路牌字，文字要自然、准确、排版清楚，不要过多。
注意：弹幕里的“[某某收藏集表情包_xxx]”或“[某某表情包_xxx]”只是观众发的表情包名称，不代表这个主播出场、连麦或参与对话；不要把表情包名称当成漫画角色。
只画语音正文、摘要事件或明确提到的真实人物；不确定时画房间主人、观众小人、道具或屏幕内容，不要凭表情包名新增主播。
如果语音正文给出团体、名单或成员关系，只能按该关系附近的正文确定成员；不能把本场其它段落提到的主播替换进这个团体。
若正文或弹幕已经明确给出现成动画、影视或游戏作品名（允许纠正明显的ASR错字），分镜和referenceUsage必须保留其规范作品名。被观看内容中的人物应是该作品的实际角色并按原作画面还原，不要改写成同题材的原创人物；作品名与角色名只用于身份约束，除非正文要求，不要把名字画成可见文字。不足以可靠识别作品时不要硬猜名称，应请求能看清人物的截图，并减少或弱化无法确认外观的角色。

输出格式：
- 先输出2~4行剪贴画分镜，格式为“分镜1：……”。若适合带字，请明确写出文字位置和内容，单处文字尽量控制在1到12个字。
- 分镜之后按重要性输出1~4行严格JSON格式的参考截图建议，每行一条，不要Markdown代码块：{"kind":"reference","timestampsSeconds":[数值1,数值2],"referenceUsage":"这些截图在最终生图时具体用于核对哪些可见事实","captureMode":"individual或sheet"}
- reference记录只是后续截图规划元数据，不是额外分镜、台词或可见文字，不计入2~4个分镜，最终画面不得画出JSON字段、时间戳或记录本身。

参考截图建议规则：
- 时间标记如“[12m]”表示录制后第12分钟，必须换算为数值秒数。每条timestampsSeconds包含1~4个去重时间点，尽量对准所需事实稳定可见的时刻；文本只能粗略定位时可给附近多个合理时间点。
- 每条建议只核对一个具体可见事实。优先选择一旦画错就会改变人物/作品身份、人物或物品数量、关键物体、动作过程、界面状态或事件结果的画面，不要只写“参考画面”。
- 对屏幕内正在被观看的新人、视频或作品角色，referenceUsage必须明确其外观、数量以及“属于屏幕内容而非本场互动角色”；不要用已确认出声的联动角色替代屏幕人物。
- captureMode=individual适合细节必须清楚的独立高清帧；captureMode=sheet适合同一用途的多个候选时刻、不同角度或连续过程。不同核对用途必须拆成不同reference。
- 核对现成作品中的人物身份与外观时，优先使用captureMode=individual，并选择能清楚看到主要角色正脸、发型和服装的时间点；不要用只有背影、转场或空景的宫格承担角色还原。sheet只适合核对整体世界观、场景或连续过程。
- 当语音里的作品名读音不稳或可能只是下一部作品预告时，将其视为候选而不是事实；游戏/影视开始后优先请求能看清标题或代表性玩法的individual截图，让最终生图以画面中的作品身份为准。
- 对游戏/影视内容，至少请求一张能看清作品标题/Logo、开场画面或代表性玩法界面的individual截图；再用sheet补充连续过程或多个谜题状态。不要只用宫格承担作品身份核对。

下面是一场直播的语音+弹幕文本，请先构思图片并用文字给我，我再拿去绘制图片。整体1200个字符以内。只返回分镜描述和reference JSON行，不要包含任何说明或其它格式。
{highlight_content}
"""


IMMERSIVE_COMIC_ARTIST_PROMPT_TEMPLATE = """你作为虚拟主播二创画师与电影分镜师，根据直播内容设计一张沉浸式直播总结插画。
角色描述：{character_desc}。
{identity_context}。
{live_context}

叙事要求：
1. 从直播中选择2~4个真正不同的高光节拍，形成清楚的起因、转折和收束；不要按时间平均切段，也不要把同一种“坐在电脑前说话”重复多次。
2. 主播应主动进入本场明确出现的游戏、电影、歌曲、故事或想象世界：奔跑、战斗、表演、探索、变身、与道具互动。不要只画她隔着屏幕观看这些内容。
3. 对正文确实出现的游戏、影视、歌曲或故事，让主播进入对应舞台和环境，但必须保留主播身份特征，不要直接替换成作品角色。若正文或弹幕已经明确给出现成作品名（允许纠正明显的ASR错字），必须在scene和referenceUsage中保留其规范作品名；同时为游戏/影视请求能看清标题或代表性玩法的individual截图。最终画面先还原截图中的作品身份、构图、色板、UI和关键道具，再叠加主播叙事，不得把作品画面泛化成“类似氛围”的原创场景。只有无法可靠识别具体作品，或内容本来就是抽象歌曲、口述故事时，才使用不冒充具体角色的氛围化环境与无名剪影。
4. 严格保留事件的语气层级：未来计划、假设、脑补、梦境或转述故事不是已经发生的事实。用想象气泡、幻想小剧场、Q版分身、梦境边框等方式明确表示想象层，例如聊未来旅行时可让Q版小头像在气泡里演出预想遭遇，不能画成主播当场真的抵达。
5. 最终构图优先一张有明确视觉中心的电影感主画面，或不对称蒙太奇、连续动作、前中后景叙事；禁止默认规则2x2四宫格、四块等大面板和编号格。
6. 整张图最多允许一个小区域出现直播桌面，且只有正文确有必要时才出现。用动作、表情、镜头距离、光线、环境和视觉隐喻表达情绪；增加文字信息时也要保持大人物和主场景的视觉优势。
7. 必须规划4~6处可直接画进成品的中文“回忆锚点”，总字数约24~60字。至少一处选用正文中最有辨识度的原话、吐槽或梗，其余分别点明不同高光节拍里的具体动作、对象、意外或结果。单处通常2~14字，拒绝“高能时刻”“精彩直播”之类空泛标签，不要生成身份牌、无来源人名或正文没有的台词。
8. 弹幕里的“[某某收藏集表情包_xxx]”或“[某某表情包_xxx]”只是观众表情包名称，不代表该主播出场；只画语音正文、摘要事件或明确提到的真实人物。
9. 时间标记如“[12m]”表示录制后第12分钟。每个节拍必须选择对应事件的时间点，并换算为数值型 timestampSeconds。
10. 叙事节拍不等于参考截图。另行判断最终插画中哪些视觉事实必须从直播原画面核对，例如作品或场景身份、人物/物品外观、数量、服装、道具、界面状态、动作过程或事件结果；不要只因为某个时间点剧情重要，就假定它也能看清需要还原的事实。

输出格式必须可解析：只输出JSON Lines，不要Markdown代码块、解释或额外文字。
第一行输出总体构图和文字规划：{"format":"immersive_v1","composition":"单一电影感主画面或不对称蒙太奇的具体方案","narrativeArc":"起因-转折-收束","textPlan":[{"text":"2~14字的原话/梗或具体事件短句","scene":"对应哪个叙事场景","visualForm":"短台词框/手写旁注/道具标签/冲击字幕/环境字之一及画面位置"}]}
随后每行输出一个叙事节拍，且字段缺一不可：{"kind":"beat","timestampSeconds":数值,"scene":"人物、动作、环境与必要短字","visualIntent":"景别、构图、光线、情绪和动态","referenceUsage":"该节拍在叙事中的用途"}
最后按重要性输出1~4个参考截图请求：{"kind":"reference","timestampsSeconds":[数值1,数值2],"referenceUsage":"这些截图在最终生图时具体用于核对哪些可见事实","captureMode":"individual或sheet"}

参考截图规划规则：
- 先根据本场内容和最终构图智能识别最需要视觉依据的事实，不使用固定题材分类，也不要为某种玩法机械套用专门规则。优先请求一旦画错就会改变事件含义或角色/物品身份的画面；普通主播桌面、重复主页或仅用于气氛的画面不必请求。
- 每个reference只服务一个清楚的核对用途。referenceUsage必须具体说明最终生图应从这些输入图中读取什么，例如核对哪些人物/物品的外观与数量、哪种界面状态、哪段动作变化、哪个真实结果或哪组场景特征；不要只写“参考画面”“核对内容”等空话。
- timestampsSeconds必须包含1~4个去重后的数值秒数，按直播时间顺序排列，并尽量对准所需事实真正稳定可见的画面，而不是只对准口头提到它的时刻。若文本只能粗略定位，就主动给出附近或相关阶段的多个合理时间点，交给后续截图共同提供依据。
- captureMode=individual时，每个时间点会成为一张独立高清输入图，适合少量且细节必须清楚、各时刻各自有价值的画面。captureMode=sheet时，多个时间点会合成一张带编号和时间标签的宫格，适合从若干候选时刻核对同一事实、对比不同角度，或理解一个事件过程。
- 核对现成作品中的人物身份与外观时，优先使用captureMode=individual，并选择能清楚看到主要角色正脸、发型和服装的时间点；不要用只有背影、转场或空景的宫格承担角色还原。sheet只适合核对整体世界观、场景或连续过程。
- 当语音里的作品名读音不稳或可能只是下一部作品预告时，将其视为候选而不是事实；游戏/影视开始后优先请求能看清标题或代表性玩法的individual截图，让最终生图以画面中的作品身份为准。
- 对游戏/影视内容，至少请求一张能看清作品标题/Logo、开场画面或代表性玩法界面的individual截图；再用sheet补充连续过程或多个谜题状态。不要只用宫格承担作品身份核对。
- 同一sheet中的各格共同服务于同一个referenceUsage，可能是候选、不同角度或连续过程，不代表最终插画必须把每格都画成独立事件。若两个画面承担不同核对用途，应拆成两个reference。
- 参考请求按对最终画面准确性的贡献从高到低输出。考虑总图片额度，只请求真正需要的画面；reference记录不计入2~4个叙事节拍。

文字规划规则：
- textPlan必须有4~6项，并覆盖所有叙事节拍；同一场景可有主短句和一个辅助细节，但不要用近义句重复同一信息。
- text必须能单独唤起本场细节：优先保留主播真实说过的短句、直播间梗、具体对象、反转和结果。原话过长时截取最有辨识度且不改变含义的片段，不能为了押韵或搞笑捏造台词。
- scene和visualForm必须把每条文字绑定到对应画面。文字应自然嵌入场景而非集中列成摘要：对话用短台词框，吐槽用手写旁注，动作或结果用冲击字幕，道具和环境信息用标签或环境字。
- 代表性原话/梗允许成为中等字号焦点，其余文字保持较小但清楚；不得设计遮挡人物脸部、关键动作或参考图要求还原对象的超大标题。
共2~4个叙事节拍、4~6个文字锚点、1~4个参考截图请求，整体不超过1800个中文字符。

下面是一场直播的语音+弹幕文本：
{highlight_content}
"""


def format_image_reference_manifest(image_manifest: Optional[list[dict]]) -> str:
    if not image_manifest:
        return ""
    lines = [
        "【参考图编号与用途】",
        "每张参考图只能按下面用途使用；人物参考图决定对应人物外观，脚本请求的直播截图用于核对本场具体视觉事实。",
        "用途是请求级事实约束。只采用图片中真正可见且与用途相关的细节；游戏/影视截图是视觉主证据，不是可有可无的氛围参考；若图中出现标题、Logo、UI、固定色板、字幕或谜题布局，应按图还原。同一请求的多图或宫格共同服务于同一个用途，不要机械画成多个分格或虚构额外事件。",
    ]
    for index, item in enumerate(image_manifest, start=1):
        role = item.get("role") or "reference"
        if role == "host":
            description = "房间主人外观参考；严格还原人物身份特征，不代表本场场景。"
        elif role in {"appeared_streamer", "mentioned_streamer"}:
            display_name = item.get("displayName") or "额外人物"
            description = f"{display_name}的外观参考；仅在漫画脚本明确需要该人物时使用。"
        elif role == "directed_screenshot":
            timestamp = item.get("timestampSeconds")
            selected_timestamp = item.get("selectedTimestampSeconds")
            usage = item.get("referenceUsage") or item.get("mustShow") or "核对该时刻的视觉事实"
            request_id = item.get("referenceRequestId")
            if request_id:
                candidate_index = item.get("candidateIndex")
                candidate_count = item.get("candidateCount")
                selection_mode = item.get("selectionMode")
                timestamps = [
                    float(value) for value in (item.get("timestampsSeconds") or [])
                    if isinstance(value, (int, float))
                ]
                if selection_mode == "script_requested_sheet" or item.get("requestSource") == "script_reference_sheet":
                    if not timestamps and isinstance(timestamp, (int, float)):
                        timestamps = [float(timestamp)]
                    time_text = "、".join(f"{value:g}秒" for value in timestamps) or "未记录"
                    count_text = f"，共{candidate_count}格" if isinstance(candidate_count, int) else ""
                    description = (
                        f"脚本参考请求{request_id}的多时间点宫格{count_text}，截图时间为{time_text}；"
                        f"用途：{usage}。逐格核对编号与时间，只提取服务于该用途的可见事实；"
                        "各格是候选、角度或过程参考，不要求全部画入成品。"
                    )
                else:
                    group_text = ""
                    if isinstance(candidate_index, int) and isinstance(candidate_count, int) and candidate_count > 1:
                        group_text = f"，同用途独立帧{candidate_index}/{candidate_count}"
                    actual_timestamp = selected_timestamp if isinstance(selected_timestamp, (int, float)) else timestamp
                    time_text = f"，截图时间为直播{actual_timestamp:g}秒" if isinstance(actual_timestamp, (int, float)) else ""
                    description = (
                        f"脚本参考请求{request_id}的高清独立帧{group_text}{time_text}；用途：{usage}。"
                        "准确采用与用途相关的可见细节，不要照搬直播界面布局。"
                    )
            elif isinstance(timestamp, (int, float)) and isinstance(selected_timestamp, (int, float)):
                description = (
                    f"脚本事件约在直播 {timestamp:g} 秒，参考图从同一事件窗口 {selected_timestamp:g} 秒选取；"
                    f"用途：{usage}。不要把截图布局照搬成直播桌面。"
                )
            elif isinstance(timestamp, (int, float)):
                description = f"直播 {timestamp:g} 秒关键帧；用途：{usage}。不要把截图布局照搬成直播桌面。"
            else:
                description = f"直播关键帧；用途：{usage}。"
        elif role == "contact_sheet":
            description = "固定时间点的直播截图拼图，只用于核对直播内容，不要求逐格复刻。"
        elif role == "cover":
            description = "直播封面，只用于主题、色彩或场景线索，不作为人物外观依据。"
        else:
            description = item.get("description") or "辅助参考图。"
        lines.append(f"- 参考图{index}：{description}")
    return "\n".join(lines)


def format_comic_identity_context(context: Dict[str, Any]) -> str:
    host = context.get("host") or {}
    host_name = host.get("displayName") or "房间主人"
    appeared_lines = []
    for item in context.get("appeared") or []:
        name = item.get("displayName") or item.get("id")
        appeared_lines.append(
            f"- {name}：ASR 已确认在本场直播中实际出声，是现场互动角色。"
        )
    appeared = "\n".join(appeared_lines) if appeared_lines else "- 无其他已确认出声角色。"
    mention_lines = []
    for item in context.get("mentions") or []:
        name = item.get("displayName") or item.get("id")
        label = item.get("_matchedMentionLabel") or name
        mention_lines.append(f"- {name}：仅在原文中被提到（命中“{label}”），不是本场嘉宾、连麦者或合唱者。")
    mentions = "\n".join(mention_lines) if mention_lines else "- 无其他已验证人物提及。"
    return f"""人物事实边界（必须遵守）：
- 本场直播主人唯一是：{host_name}。不要把 ASR、弹幕或模型记忆里的其他名字改写成主播。
- 已确认在本场实际出声的互动角色：
{appeared}
- 已验证的文字提及：
{mentions}
- 已确认出声的互动角色应按正文中的共同事件参与画面，不要用粉丝吉祥物或路人替代。
- 被提到的人只能按照原文明确的事件画成回忆/游戏画面/屏幕内容；绝不能自动成为嘉宾、连麦者、合唱者或本场直播角色。
- 不要在画面中生成“主播”“嘉宾”“主持”“连麦”等身份牌，也不要生成或翻译人名（包括中文名、英文名、拼音）。人名不是必要画面文字时一律省略。"""
