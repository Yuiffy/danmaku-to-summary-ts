"""Add new seedance queue tasks."""
import json
import os

queue_path = r'D:\files\Pictures\AI图保存\seedance\近期岁己居家下载\seedance_queue.json'
with open(queue_path, 'r', encoding='utf-8') as f:
    q = json.load(f)

AI = r'D:\files\Pictures\保存素材\小花帽\AI素材'
GPT = r'D:\files\Pictures\AI图保存\gpt'
CAT = r'D:\files\Pictures\保存素材\小猫帽'

# Verified existing reference images
sui_red = os.path.join(AI, '红白健身服装2.png')
sui_red1 = os.path.join(AI, '红白健身服装1.png')
bing = os.path.join(AI, '饼干岁人2.png')
bing1 = os.path.join(AI, '饼干岁人1.png')
red_style = os.path.join(AI, '红白健身服装2定妆插画.png')
sui_sweat = os.path.join(AI, '岁己运动后擦汗参考.jpg')
sleep_3v = os.path.join(AI, '吊带连衣裙三视图.png')
sleep_style = os.path.join(AI, '吊带连衣裙睡衣定妆插画.png')
short_sleep = os.path.join(AI, '短裤睡衣三视图.png')
blue_3v = os.path.join(AI, '小蓝帽三视图.png')
sui_hat = r'D:\files\Pictures\保存素材\小花帽\73913dc4ed291e630f765bd14bcd15cc1954091502.png'
cat_suit = os.path.join(CAT, '岁己SUI小猫帽带饼干岁紫色外套双马尾.png')

new_tasks = [
    {
        'id': 'task_073',
        'name': '漫展逛展-岁己拉着小饼在摊位间穿行',
        'prompt': '16:9横屏，高质量二次元动画，明亮热闹的漫展会场。岁己（参考小蓝帽三视图形象）穿着casual外出服，拉着男友小饼（参考饼干岁人2形象）的手腕在摊位间兴奋穿行。会场灯光明亮，两侧是同人摊位和立牌，背景有模糊的Coser人群但不抢镜。岁己回头笑着说话，银白色双马尾随着走动轻快摇摆。小饼戴着饼干头和小皇冠，被她拽得踉跄但表情宠溺。镜头以跟拍和中景为主，突出两人互动和漫展氛围。动作自然连贯，人物不要变形，角色身份稳定，画面干净高级。',
        'reference_images': [blue_3v, bing, sui_hat],
        'repeat': 3,
    },
    {
        'id': 'task_074',
        'name': '射箭馆体验-岁己拉弓瞄准小饼紧张旁观',
        'prompt': '16:9横屏，高质量二次元动画，偏运动风。岁己（参考红白健身服装2形象）在室内射箭馆里，手持反曲弓，站在起射线上拉弓瞄准靶子。她穿着运动背心和短裤，身体线条修长健康，拉弓时肩背和手臂肌肉线条清晰有力。银白色双马尾扎成低马尾，专注的表情带着一点紧张。小饼（参考饼干岁人2形象）站在她身后安全线外，双手紧张地握拳，表情又期待又害怕。镜头从侧面中景展示拉弓姿态，再切到弓弦释放的特写，箭飞出去的瞬间。注意人体结构和肌肉、赘肉的自然表现。镜头平稳连贯，人物不要变形。',
        'reference_images': [sui_red, bing, red_style, sui_sweat],
        'repeat': 3,
    },
    {
        'id': 'task_075',
        'name': '居酒屋约会-岁己微醺靠在小饼肩上',
        'prompt': '16:9横屏，高质量二次元动画，温暖的日式居酒屋夜景。岁己（参考小蓝帽三视图形象）和小饼（参考饼干岁人2形象）面对面坐在居酒屋的吧台边，面前摆着烤串、毛豆和小酒杯。暖黄色灯笼光照亮两人的脸，背景有模糊的酒瓶架。岁己脸颊微红，眼神微醺，一手撑着脸颊，另一手拿着小酒杯晃了晃，嘴角带着笑意说话。小饼在旁边认真听着，微微点头。镜头从中景缓慢推近到岁己的近景，突出她微醺的红晕和温柔表情。氛围温暖、安静、有生活感，动作自然连贯，人物不要变形。',
        'reference_images': [blue_3v, bing, sui_hat],
        'repeat': 3,
    },
    {
        'id': 'task_076',
        'name': '居家玩偶-岁己抱着大毛绒玩偶在沙发上打滚',
        'prompt': '16:9横屏，高质量二次元动画，温馨居家场景。岁己（参考吊带连衣裙三视图形象）穿着宽松的居家吊带裙，怀里抱着一个比她上半身还大的毛绒玩偶，在客厅沙发上开心地打滚。她整个人趴在玩偶上，双腿在空中晃动，银白色双马尾散落在沙发靠垫上，表情幸福满足。客厅里有温暖的灯光，茶几上放着饮料和零食。小饼（参考饼干岁人2形象）坐在沙发另一端，看着她笑。镜头从俯拍全身到侧面中景，突出岁己和玩偶的尺寸对比、居家的松弛感。动作自然可爱，画面干净高级，人物不要变形。',
        'reference_images': [sleep_3v, bing, sleep_style],
        'repeat': 3,
    },
    {
        'id': 'task_077',
        'name': '公园踢足球-岁己带球过人小饼守门被晃倒',
        'prompt': '16:9横屏，高质量二次元动画，夏日公园草地。岁己（参考红白健身服装2形象）穿着运动背心和短裤，脚踩足球，在公园草地上带球冲刺。她表情自信，动作利落，银白色双马尾在跑动中飞扬，腿部线条修长有力。小饼（参考饼干岁人2形象）站在简易球门前（用两件外套当球门柱），张开双臂做出守门姿势，表情紧张又认真。镜头展示岁己带球变向的流畅动作，晃过小饼，球滚进球门。岁己转身举起拳头庆祝，阳光照在她微微出汗的脸上。小饼坐在草地上无奈笑着摇头。镜头强调带球变向的流畅动作、岁己的灵活身姿、小饼被晃倒的喜剧感、金色夕阳和草地氛围。动作连贯有速度感，人物不要变形。',
        'reference_images': [sui_red, bing, red_style, sui_sweat],
        'repeat': 3,
    },
    {
        'id': 'task_078',
        'name': '深夜泡面-岁己掀开锅盖蒸汽扑面满足微笑',
        'prompt': '16:9横屏，高质量二次元动画，深夜厨房温暖场景。岁己（参考吊带连衣裙三视图形象）穿着宽松居家吊带裙，站在厨房炉灶前，刚刚掀开小锅盖，大量热蒸汽扑面而来。锅里煮着方便面，有鸡蛋和火腿肠。她被蒸汽熏得眯起眼睛，嘴角露出满足的微笑，银白色双马尾有点随意地垂在肩上。厨房灯光温暖偏暗，台面上放着调料包和筷子。小饼（参考饼干岁人2形象）从画面边缘探出头，也好奇地凑过来看锅。镜头从掀锅盖的特写开始，蒸汽散开后切到岁己满足微笑的近景，再拉远到两人一起等待的中景。氛围温暖、生活化、有食欲感，动作自然连贯，人物不要变形。',
        'reference_images': [sleep_3v, bing, short_sleep],
        'repeat': 3,
    },
]

for t in new_tasks:
    t['completed'] = 0
    t['status'] = 'pending'
    t['submit_ids'] = []
    q['tasks'].append(t)
    print(f'Added {t["id"]}: {t["name"]}')

with open(queue_path, 'w', encoding='utf-8') as f:
    json.dump(q, f, ensure_ascii=False, indent=2)
print(f'Done. Total tasks: {len(q["tasks"])}')
