"""Language-neutral configuration precedence and secret aliases."""

import json
import os
import copy
from pathlib import Path

CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "core/config/config-contract.json").read_text(encoding="utf-8-sig"))


def deep_merge(target, source):
    result = target.copy()
    for key, value in source.items():
        if key in ("__proto__", "constructor", "prototype"):
            continue
        result[key] = deep_merge(result[key], value) if isinstance(result.get(key), dict) and isinstance(value, dict) else value
    return result


def get_value(source, dotted_path):
    for key in dotted_path.split("."):
        if not isinstance(source, dict):
            return None
        source = source.get(key)
    return source


def set_value(target, dotted_path, value):
    keys = dotted_path.split(".")
    for key in keys[:-1]:
        if not isinstance(target.get(key), dict):
            target[key] = {}
        target = target[key]
    key = keys[-1]
    target[key] = deep_merge(target[key], value) if isinstance(target.get(key), dict) and isinstance(value, dict) else value


def transform_secrets(secrets):
    result = {}
    for mapping in CONTRACT["secretMappings"]:
        for source in mapping["sources"]:
            value = get_value(secrets, source)
            if value is not None and value is not False and value != "" and value != 0:
                set_value(result, mapping["target"], value)
                break
    alias = CONTRACT["daiYuTextAlias"]
    provider = get_value(result, alias["provider"])
    if isinstance(provider, dict) and provider.get("apiKey"):
        set_value(result, alias["target"] + ".apiKey", provider["apiKey"])
        base = provider.get("baseURL")
        base_url = base.removesuffix("/v1") if isinstance(base, str) and base else provider.get("baseUrl") or alias["defaultBaseUrl"]
        set_value(result, alias["target"] + ".baseUrl", base_url)
    return result


def read_json_object(file):
    with open(file, encoding="utf-8-sig") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"Configuration must be a JSON object: {file}")
    return value


def find_config_paths(root, env=None, config_path=None):
    env = os.environ if env is None else env
    base = Path(root) / "config" / CONTRACT["baseFile"]
    explicit = config_path or env.get("CONFIG_PATH")
    production = env.get("NODE_ENV", CONTRACT["defaultEnvironment"]) in CONTRACT["productionEnvironments"]
    selected = (Path(root) / explicit).resolve() if explicit else Path(root) / "config" / CONTRACT["productionFile"] if production else base
    if explicit and not selected.exists():
        raise FileNotFoundError(f"Explicit configuration file does not exist: {selected}")
    chosen = selected if selected.exists() else base
    return [str(chosen)] if chosen.exists() else []


def load_config_layers(root, env=None, config_path=None):
    env = os.environ if env is None else env
    config = {}
    for file in find_config_paths(root, env, config_path):
        config = deep_merge(config, read_json_object(file))
    secret_file = Path(root) / "config" / CONTRACT["secretFile"]
    if secret_file.exists():
        config = deep_merge(config, transform_secrets(read_json_object(secret_file)))
    for variable, target in CONTRACT["environmentMappings"].items():
        if env.get(variable):
            set_value(config, target, env[variable])
    modes_file = Path(root) / 'config' / 'generation-modes.json'
    modes = {}
    if modes_file.exists():
        catalog = read_json_object(modes_file)
        if catalog.get('schemaVersion') != 1 or not isinstance(catalog.get('modes'), dict):
            raise ValueError('Invalid generation mode catalog')
        modes = catalog['modes']
    return resolve_generation_modes(config, modes)


def resolve_generation_modes(config, catalog=None):
    ai = config.get('ai')
    if not isinstance(ai, dict):
        return config
    modes = deep_merge(catalog or {}, ai.get('generationModes') if isinstance(ai.get('generationModes'), dict) else {})
    rooms = ai.get('roomSettings') if isinstance(ai.get('roomSettings'), dict) else {}
    allowed = {'wordLimit', 'minComicDurationMinutes', 'comicGenerationProbability', 'fullLiveContextExperiment', 'imageGeneration'}
    resolved = {}

    def resolve(name, visiting=()):
        if not isinstance(name, str) or not name or name not in modes:
            raise ValueError(f'Unknown generation mode: {name}')
        if name in visiting:
            raise ValueError('Generation mode inheritance cycle: ' + ' -> '.join((*visiting, name)))
        if name in resolved:
            return resolved[name]
        mode = modes[name]
        if not isinstance(mode, dict) or not isinstance(mode.get('settings'), dict):
            raise ValueError(f'Invalid generation mode: {name}')
        for key in mode['settings']:
            if key not in allowed:
                raise ValueError(f'Invalid generation mode setting: {name}.{key}')
        parent = resolve(mode['extends'], (*visiting, name)) if 'extends' in mode else {}
        resolved[name] = deep_merge(parent, mode['settings'])
        return resolved[name]

    for name in modes:
        resolve(name)
    if 'defaultGenerationMode' in ai:
        resolve(ai['defaultGenerationMode'])
    expanded = {}
    for room_id, room in rooms.items():
        if not isinstance(room, dict):
            raise ValueError(f'Invalid room settings: {room_id}')
        name = room.get('generationMode') if room.get('generationMode') is not None else ai.get('defaultGenerationMode')
        expanded[room_id] = {**deep_merge(copy.deepcopy(resolve(name)), room), 'generationMode': name} if name is not None else room
    return {**config, 'ai': {**ai, **({'generationModes': modes} if modes else {}), **({'roomSettings': expanded} if 'roomSettings' in ai else {})}}
