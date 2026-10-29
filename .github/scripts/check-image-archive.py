"""Inspect every saved layer, including deleted files, in Docker/OCI archives."""
import json
import tarfile
from pathlib import PurePosixPath

# Docker save includes manifest.json for both classic and containerd stores.
# Two streaming passes avoid extracting layers or repeatedly seeking gzip data.
layers = None
with tarfile.open("candidate-image/image.tar.gz", "r|gz") as archive:
    for entry in archive:
        if entry.name == "manifest.json":
            manifest = json.load(archive.extractfile(entry))
            assert len(manifest) == 1, "exactly one saved image required"
            layers = set(manifest[0]["Layers"])
assert layers, "no image layers found"
seen = set()
with tarfile.open("candidate-image/image.tar.gz", "r|gz") as archive:
    for entry in archive:
        if entry.name not in layers:
            continue
        seen.add(entry.name)
        with tarfile.open(fileobj=archive.extractfile(entry), mode="r|*") as layer:
            for item in layer:
                path = PurePosixPath(item.name)
                assert ".." not in path.parts, "unexpected traversal in image layer"
                parts = path.parts
                if parts and parts[0] == "app" and len(parts) > 1:
                    assert parts[1] not in {"test", "docs", "runtime-evidence", "registry-evidence", "candidate-image", ".git", ".github"}, str(path)
                    assert not parts[1].startswith(".env"), str(path)
assert seen == layers, "all saved layers must be inspected"
print(json.dumps({"ownedEnvFixturesEvidenceInLayers": False, "layersChecked": len(seen)}))
