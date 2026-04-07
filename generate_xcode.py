#!/usr/bin/env python3
"""
Generate an Xcode project for Ardour with proper PBXNativeTarget entries
(dynamic libraries, tools) so they appear as real targets in Xcode, not aggregates.
Build still invokes waf via a shell script phase since Ardour's build is too
complex for native Xcode compilation, but the targets are properly typed
with source files in build phases for indexing.
"""

import os
import uuid
import subprocess
from pathlib import Path
from collections import OrderedDict

ARDOUR_DIR = Path(__file__).parent.resolve()
XCODEPROJ_DIR = ARDOUR_DIR / "Ardour.xcodeproj"
BUILD_SCRIPT = ARDOUR_DIR / "build_ardour.sh"

SOURCE_EXTS = {'.c', '.cc', '.cpp', '.cxx', '.m', '.mm'}
HEADER_EXTS = {'.h', '.hh', '.hpp', '.hxx'}
ALL_EXTS = SOURCE_EXTS | HEADER_EXTS

SKIP_DIRS = {'.git', 'build', '.waf3-2.0.26-44bc421a5f6bb452d70d83cbd5abc3fa',
             'Ardour.xcodeproj', '__pycache__', '.waf'}

# (target_name, source_dir, product_type, product_name)
# product_type: 'lib' -> com.apple.product-type.library.dynamic
#               'exe' -> com.apple.product-type.tool
#               'bundle' -> com.apple.product-type.bundle
TARGETS = [
    # Core libraries
    ('libpbd',           'libs/pbd',            'lib',    'libpbd.dylib'),
    ('libevoral',        'libs/evoral',          'lib',    'libevoral.dylib'),
    ('libtemporal',      'libs/temporal',        'lib',    'libtemporal.dylib'),
    ('libmidipp',        'libs/midi++2',         'lib',    'libmidipp.dylib'),
    ('libardour',        'libs/ardour',          'lib',    'libardour.dylib'),
    ('libaaf',           'libs/aaf',             'lib',    'libaaf.dylib'),
    ('libptformat',      'libs/ptformat',        'lib',    'libptformat.dylib'),
    ('libaudiographer',  'libs/audiographer',    'lib',    'libaudiographer.dylib'),

    # UI libraries
    ('libgtkmm2ext',     'libs/gtkmm2ext',       'lib',    'libgtkmm2ext.dylib'),
    ('libcanvas',        'libs/canvas',           'lib',    'libcanvas.dylib'),
    ('libwidgets',       'libs/widgets',          'lib',    'libwidgets.dylib'),
    ('libwaveview',      'libs/waveview',         'lib',    'libwaveview.dylib'),

    # Toolkit (bundled GTK)
    ('libztk',           'libs/tk/ztk',           'lib',    'libztk.dylib'),
    ('libydk',           'libs/tk/ydk',           'lib',    'libydk.dylib'),
    ('libydk-pixbuf',    'libs/tk/ydk-pixbuf',    'lib',    'libydk-pixbuf.dylib'),
    ('libytk',           'libs/tk/ytk',           'lib',    'libytk.dylib'),
    ('libztkmm',         'libs/tk/ztkmm',         'lib',    'libztkmm.dylib'),
    ('libydkmm',         'libs/tk/ydkmm',         'lib',    'libydkmm.dylib'),
    ('libytkmm',         'libs/tk/ytkmm',         'lib',    'libytkmm.dylib'),

    # Audio/DSP
    ('libqm-dsp',        'libs/qm-dsp',          'lib',    'libqm-dsp.dylib'),
    ('liblua',           'libs/lua',             'lib',    'liblua.dylib'),
    ('libltc',           'libs/libltc',           'lib',    'libltc.dylib'),
    ('libfluidsynth',    'libs/fluidsynth',       'lib',    'libfluidsynth.dylib'),
    ('libclearlooks',    'libs/clearlooks-newer', 'lib',    'libclearlooks.dylib'),
    ('libappleutility',  'libs/appleutility',     'lib',    'libappleutility.dylib'),

    # Vamp plugins
    ('libvamp-plugins',  'libs/vamp-plugins',     'lib',    'libvamp-plugins.dylib'),
    ('libvamp-pyin',     'libs/vamp-pyin',        'lib',    'libvamp-pyin.dylib'),

    # Audio backends
    ('backend-coreaudio','libs/backends/coreaudio','bundle','coreaudio_backend.bundle'),
    ('backend-dummy',    'libs/backends/dummy',    'bundle','dummy_backend.bundle'),

    # Control surfaces
    ('surface-osc',              'libs/surfaces/osc',              'bundle','ardour_osc.bundle'),
    ('surface-mackie',           'libs/surfaces/mackie',           'bundle','ardour_mackie.bundle'),
    ('surface-generic-midi',     'libs/surfaces/generic_midi',     'bundle','ardour_generic_midi.bundle'),
    ('surface-faderport',        'libs/surfaces/faderport',        'bundle','ardour_faderport.bundle'),
    ('surface-faderport8',       'libs/surfaces/faderport8',       'bundle','ardour_faderport8.bundle'),
    ('surface-push2',            'libs/surfaces/push2',            'bundle','ardour_push2.bundle'),
    ('surface-launchpad-pro',    'libs/surfaces/launchpad_pro',    'bundle','ardour_launchpad_pro.bundle'),
    ('surface-launchpad-x',      'libs/surfaces/launchpad_x',     'bundle','ardour_launchpad_x.bundle'),
    ('surface-launch-control-xl','libs/surfaces/launch_control_xl','bundle','ardour_lcxl.bundle'),
    ('surface-cc121',            'libs/surfaces/cc121',            'bundle','ardour_cc121.bundle'),
    ('surface-us2400',           'libs/surfaces/us2400',           'bundle','ardour_us2400.bundle'),
    ('surface-contourdesign',    'libs/surfaces/contourdesign',    'bundle','ardour_contourdesign.bundle'),
    ('surface-websockets',       'libs/surfaces/websockets',       'bundle','ardour_websockets.bundle'),
    ('surface-console1',         'libs/surfaces/console1',         'bundle','ardour_console1.bundle'),

    # Built-in plugins / panners / vst3
    ('plugins',          'libs/plugins',          'lib',    'libplugins.dylib'),
    ('panners',          'libs/panners',          'lib',    'libpanners.dylib'),
    ('libvst3',          'libs/vst3',             'lib',    'libvst3.dylib'),

    # Zita
    ('libzita-convolver',  'libs/zita-convolver',  'lib',  'libzita-convolver.dylib'),
    ('libzita-resampler',  'libs/zita-resampler',  'lib',  'libzita-resampler.dylib'),

    # Executables
    ('ardour-gui',       'gtk2_ardour',           'app',   'Ardour.app'),
    ('ardour-lua',       'luasession',            'exe',   'ardour-lua'),
    ('hardour',          'headless',              'exe',   'hardour'),
    ('session-utils',    'session_utils',          'exe',   'ardour-export'),

    # Other libs
    ('hidapi',           'libs/hidapi',            'lib',   'libhidapi.dylib'),
    ('fst',              'libs/fst',               'lib',   'libfst.dylib'),
    ('staffpad',         'libs/staffpad',           'lib',   'libstaffpad.dylib'),
]

PRODUCT_TYPE_MAP = {
    'lib':    'com.apple.product-type.library.dynamic',
    'exe':    'com.apple.product-type.tool',
    'bundle': 'com.apple.product-type.bundle',
    'app':    'com.apple.product-type.application',
}

PRODUCT_FILE_TYPE_MAP = {
    'lib':    'compiled.mach-o.dylib',
    'exe':    'compiled.mach-o.executable',
    'bundle': 'wrapper.cfbundle',
    'app':    'wrapper.application',
}


def gen_uuid():
    return uuid.uuid4().hex[:24].upper()


def file_type_for_ext(ext):
    return {
        '.c': 'sourcecode.c.c', '.cc': 'sourcecode.cpp.cpp',
        '.cpp': 'sourcecode.cpp.cpp', '.cxx': 'sourcecode.cpp.cpp',
        '.m': 'sourcecode.c.objc', '.mm': 'sourcecode.cpp.objcpp',
        '.h': 'sourcecode.c.h', '.hh': 'sourcecode.cpp.h',
        '.hpp': 'sourcecode.cpp.h', '.hxx': 'sourcecode.cpp.h',
    }.get(ext, 'text')


def collect_files_for_dir(source_dir_rel):
    full_dir = ARDOUR_DIR / source_dir_rel
    if not full_dir.exists():
        return OrderedDict(), []

    groups = OrderedDict()
    all_files = []

    for dirpath, dirnames, filenames in os.walk(full_dir):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in sorted(filenames):
            ext = os.path.splitext(f)[1]
            if ext in ALL_EXTS:
                relpath = os.path.relpath(os.path.join(dirpath, f), ARDOUR_DIR)
                rel_from_source = os.path.relpath(dirpath, full_dir)
                group_key = source_dir_rel if rel_from_source == '.' else f"{source_dir_rel}/{rel_from_source}"
                groups.setdefault(group_key, []).append((f, relpath, ext))
                all_files.append((f, relpath, ext))

    return groups, all_files


def get_include_paths():
    paths = set()
    paths.add(str(ARDOUR_DIR))
    paths.add('/opt/homebrew/include')
    for d in ARDOUR_DIR.glob('libs/*/'):
        if d.is_dir():
            paths.add(str(d))
    pkgs = ['glib-2.0', 'glibmm-2.4', 'gtk+-2.0', 'gtkmm-2.4',
            'cairomm-1.0', 'pangomm-1.4', 'sigc++-2.0', 'lv2', 'lilv-0',
            'sndfile', 'liblo', 'rubberband', 'fftw3f', 'libarchive',
            'serd-0', 'sord-0', 'sratom-0']
    for pkg in pkgs:
        try:
            r = subprocess.run(['pkg-config', '--cflags-only-I', pkg],
                               capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                for flag in r.stdout.strip().split():
                    if flag.startswith('-I'):
                        paths.add(flag[2:])
        except Exception:
            pass
    return sorted(paths)


def generate_pbxproj():
    project_uuid = gen_uuid()
    main_group_uuid = gen_uuid()
    products_group_uuid = gen_uuid()
    config_list_project_uuid = gen_uuid()
    project_debug_uuid = gen_uuid()
    project_release_uuid = gen_uuid()

    # Accumulate pbxproj sections
    file_ref_lines = []
    build_file_lines = []
    group_lines = []
    native_target_lines = []
    shell_phase_lines = []
    sources_phase_lines = []
    config_lines = []
    config_list_lines = []

    top_level_children = []
    product_ref_uuids = []
    target_entries = []  # (target_uuid, target_name)

    file_ref_map = {}  # relpath -> file_ref_uuid

    def get_file_ref(filename, relpath, ext):
        if relpath in file_ref_map:
            return file_ref_map[relpath]
        ref_uuid = gen_uuid()
        ftype = file_type_for_ext(ext)
        file_ref_lines.append(
            f'\t\t{ref_uuid} /* {filename} */ = {{isa = PBXFileReference; '
            f'lastKnownFileType = {ftype}; name = "{filename}"; '
            f'path = "{relpath}"; sourceTree = SOURCE_ROOT; }};')
        file_ref_map[relpath] = ref_uuid
        return ref_uuid

    for target_name, source_dir, ptype, product_name in TARGETS:
        groups, all_files = collect_files_for_dir(source_dir)
        if not all_files:
            continue

        # UUIDs for this target
        target_uuid = gen_uuid()
        product_ref_uuid = gen_uuid()
        sources_phase_uuid = gen_uuid()
        shell_phase_uuid = gen_uuid()
        frameworks_phase_uuid = gen_uuid()
        config_list_uuid = gen_uuid()
        debug_config_uuid = gen_uuid()
        release_config_uuid = gen_uuid()

        target_entries.append((target_uuid, target_name))

        # Product file reference
        product_file_type = PRODUCT_FILE_TYPE_MAP[ptype]
        file_ref_lines.append(
            f'\t\t{product_ref_uuid} /* {product_name} */ = {{isa = PBXFileReference; '
            f'explicitFileType = "{product_file_type}"; includeInIndex = 0; '
            f'path = "{product_name}"; sourceTree = BUILT_PRODUCTS_DIR; }};')
        product_ref_uuids.append(product_ref_uuid)

        # File refs only (no build files — waf compiles, not Xcode)
        for filename, relpath, ext in all_files:
            get_file_ref(filename, relpath, ext)

        # PBXShellScriptBuildPhase (actual build via waf)
        shell_phase_lines.append(f'\t\t{shell_phase_uuid} /* Build with waf */ = {{')
        shell_phase_lines.append('\t\t\tisa = PBXShellScriptBuildPhase;')
        shell_phase_lines.append('\t\t\tbuildActionMask = 2147483647;')
        shell_phase_lines.append('\t\t\tfiles = (')
        shell_phase_lines.append('\t\t\t);')
        shell_phase_lines.append('\t\t\tinputPaths = (')
        shell_phase_lines.append('\t\t\t);')
        shell_phase_lines.append('\t\t\tname = "Build with waf";')
        shell_phase_lines.append('\t\t\toutputPaths = (')
        shell_phase_lines.append('\t\t\t);')
        shell_phase_lines.append(f'\t\t\tshellPath = /bin/bash;')
        shell_phase_lines.append(f'\t\t\tshellScript = "{BUILD_SCRIPT} build";')
        shell_phase_lines.append('\t\t\tshowEnvVarsInLog = 0;')
        shell_phase_lines.append('\t\t\talwaysOutOfDate = 1;')
        shell_phase_lines.append('\t\t};')

        # Groups for this target
        target_group_uuid = gen_uuid()
        sub_group_uuids = []

        for group_path in sorted(groups.keys()):
            files = groups[group_path]
            g_uuid = gen_uuid()
            children = []
            for fname, rpath, ext in files:
                children.append(get_file_ref(fname, rpath, ext))

            display = group_path.split('/')[-1]
            dir_path = os.path.dirname(files[0][1]) if files else group_path

            group_lines.append(f'\t\t{g_uuid} /* {display} */ = {{')
            group_lines.append('\t\t\tisa = PBXGroup;')
            group_lines.append('\t\t\tchildren = (')
            for c in children:
                group_lines.append(f'\t\t\t\t{c},')
            group_lines.append('\t\t\t);')
            group_lines.append(f'\t\t\tname = "{display}";')
            group_lines.append(f'\t\t\tpath = "{dir_path}";')
            group_lines.append('\t\t\tsourceTree = SOURCE_ROOT;')
            group_lines.append('\t\t};')
            sub_group_uuids.append(g_uuid)

        group_lines.append(f'\t\t{target_group_uuid} /* {target_name} */ = {{')
        group_lines.append('\t\t\tisa = PBXGroup;')
        group_lines.append('\t\t\tchildren = (')
        for sg in sub_group_uuids:
            group_lines.append(f'\t\t\t\t{sg},')
        group_lines.append('\t\t\t);')
        group_lines.append(f'\t\t\tname = "{target_name}";')
        group_lines.append(f'\t\t\tpath = "{source_dir}";')
        group_lines.append('\t\t\tsourceTree = SOURCE_ROOT;')
        group_lines.append('\t\t};')
        top_level_children.append(target_group_uuid)

        # PBXNativeTarget
        xc_product_type = PRODUCT_TYPE_MAP[ptype]
        native_target_lines.append(f'\t\t{target_uuid} /* {target_name} */ = {{')
        native_target_lines.append('\t\t\tisa = PBXNativeTarget;')
        native_target_lines.append(f'\t\t\tbuildConfigurationList = {config_list_uuid};')
        native_target_lines.append('\t\t\tbuildPhases = (')
        native_target_lines.append(f'\t\t\t\t{shell_phase_uuid} /* Build with waf */,')
        native_target_lines.append('\t\t\t);')
        native_target_lines.append('\t\t\tbuildRules = (')
        native_target_lines.append('\t\t\t);')
        native_target_lines.append('\t\t\tdependencies = (')
        native_target_lines.append('\t\t\t);')
        native_target_lines.append(f'\t\t\tname = "{target_name}";')
        native_target_lines.append(f'\t\t\tproductName = "{target_name}";')
        native_target_lines.append(f'\t\t\tproductReference = {product_ref_uuid} /* {product_name} */;')
        native_target_lines.append(f'\t\t\tproductType = "{xc_product_type}";')
        native_target_lines.append('\t\t};')

        # Per-target build configs
        for cfg_uuid, cfg_name in [(debug_config_uuid, 'Debug'), (release_config_uuid, 'Release')]:
            config_lines.append(f'\t\t{cfg_uuid} /* {cfg_name} */ = {{')
            config_lines.append('\t\t\tisa = XCBuildConfiguration;')
            config_lines.append('\t\t\tbuildSettings = {')
            config_lines.append(f'\t\t\t\tPRODUCT_NAME = "{product_name}";')
            config_lines.append(f'\t\t\t\tEXECUTABLE_PREFIX = "";')
            if ptype == 'app':
                config_lines.append('\t\t\t\tGENERATE_INFOPLIST_FILE = YES;')
                config_lines.append('\t\t\t\tCODE_SIGN_IDENTITY = "-";')
                config_lines.append('\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = org.ardour.Ardour;')
            config_lines.append('\t\t\t};')
            config_lines.append(f'\t\t\tname = {cfg_name};')
            config_lines.append('\t\t};')

        config_list_lines.append(f'\t\t{config_list_uuid} /* {target_name} */ = {{')
        config_list_lines.append('\t\t\tisa = XCConfigurationList;')
        config_list_lines.append('\t\t\tbuildConfigurations = (')
        config_list_lines.append(f'\t\t\t\t{debug_config_uuid} /* Debug */,')
        config_list_lines.append(f'\t\t\t\t{release_config_uuid} /* Release */,')
        config_list_lines.append('\t\t\t);')
        config_list_lines.append('\t\t\tdefaultConfigurationIsVisible = 0;')
        config_list_lines.append('\t\t\tdefaultConfigurationName = Release;')
        config_list_lines.append('\t\t};')

    # Include paths for project-level config
    include_paths = get_include_paths()

    # Assemble final pbxproj
    lines = []
    lines.append('// !$*UTF8*$!')
    lines.append('{')
    lines.append('\tarchiveVersion = 1;')
    lines.append('\tclasses = {')
    lines.append('\t};')
    lines.append('\tobjectVersion = 56;')
    lines.append('\tobjects = {')
    lines.append('')

    # PBXFileReference
    lines.append('/* Begin PBXFileReference section */')
    lines.extend(sorted(file_ref_lines))
    lines.append('/* End PBXFileReference section */')
    lines.append('')

    # PBXGroup
    lines.append('/* Begin PBXGroup section */')
    # Main group
    lines.append(f'\t\t{main_group_uuid} = {{')
    lines.append('\t\t\tisa = PBXGroup;')
    lines.append('\t\t\tchildren = (')
    for c in top_level_children:
        lines.append(f'\t\t\t\t{c},')
    lines.append(f'\t\t\t\t{products_group_uuid} /* Products */,')
    lines.append('\t\t\t);')
    lines.append('\t\t\tsourceTree = "<group>";')
    lines.append('\t\t};')
    # Products group
    lines.append(f'\t\t{products_group_uuid} /* Products */ = {{')
    lines.append('\t\t\tisa = PBXGroup;')
    lines.append('\t\t\tchildren = (')
    for pr in product_ref_uuids:
        lines.append(f'\t\t\t\t{pr},')
    lines.append('\t\t\t);')
    lines.append('\t\t\tname = Products;')
    lines.append('\t\t\tsourceTree = "<group>";')
    lines.append('\t\t};')
    lines.extend(group_lines)
    lines.append('/* End PBXGroup section */')
    lines.append('')

    # PBXNativeTarget
    lines.append('/* Begin PBXNativeTarget section */')
    lines.extend(native_target_lines)
    lines.append('/* End PBXNativeTarget section */')
    lines.append('')

    # PBXProject
    lines.append('/* Begin PBXProject section */')
    lines.append(f'\t\t{project_uuid} /* Project object */ = {{')
    lines.append('\t\t\tisa = PBXProject;')
    lines.append(f'\t\t\tbuildConfigurationList = {config_list_project_uuid};')
    lines.append('\t\t\tcompatibilityVersion = "Xcode 14.0";')
    lines.append('\t\t\tdevelopmentRegion = en;')
    lines.append('\t\t\thasScannedForEncodings = 0;')
    lines.append('\t\t\tknownRegions = (en);')
    lines.append(f'\t\t\tmainGroup = {main_group_uuid};')
    lines.append(f'\t\t\tproductRefGroup = {products_group_uuid} /* Products */;')
    lines.append(f'\t\t\tprojectDirPath = "{ARDOUR_DIR}";')
    lines.append('\t\t\tprojectRoot = "";')
    lines.append('\t\t\ttargets = (')
    for t_uuid, t_name in target_entries:
        lines.append(f'\t\t\t\t{t_uuid} /* {t_name} */,')
    lines.append('\t\t\t);')
    lines.append('\t\t};')
    lines.append('/* End PBXProject section */')
    lines.append('')

    # PBXShellScriptBuildPhase
    lines.append('/* Begin PBXShellScriptBuildPhase section */')
    lines.extend(shell_phase_lines)
    lines.append('/* End PBXShellScriptBuildPhase section */')
    lines.append('')

    # XCBuildConfiguration
    lines.append('/* Begin XCBuildConfiguration section */')
    # Project-level
    for cfg_uuid, cfg_name in [(project_debug_uuid, 'Debug'), (project_release_uuid, 'Release')]:
        lines.append(f'\t\t{cfg_uuid} /* {cfg_name} */ = {{')
        lines.append('\t\t\tisa = XCBuildConfiguration;')
        lines.append('\t\t\tbuildSettings = {')
        lines.append('\t\t\t\tHEADER_SEARCH_PATHS = (')
        for p in include_paths:
            lines.append(f'\t\t\t\t\t"{p}",')
        lines.append('\t\t\t\t);')
        lines.append('\t\t\t\tUSE_HEADERMAP = NO;')
        lines.append('\t\t\t\tCLANG_CXX_LANGUAGE_STANDARD = "c++17";')
        lines.append('\t\t\t\tMACOSX_DEPLOYMENT_TARGET = 11.0;')
        lines.append('\t\t\t\tARCHS = arm64;')
        lines.append('\t\t\t\tSDKROOT = macosx;')
        lines.append('\t\t\t};')
        lines.append(f'\t\t\tname = {cfg_name};')
        lines.append('\t\t};')
    lines.extend(config_lines)
    lines.append('/* End XCBuildConfiguration section */')
    lines.append('')

    # XCConfigurationList
    lines.append('/* Begin XCConfigurationList section */')
    lines.append(f'\t\t{config_list_project_uuid} /* Project */ = {{')
    lines.append('\t\t\tisa = XCConfigurationList;')
    lines.append('\t\t\tbuildConfigurations = (')
    lines.append(f'\t\t\t\t{project_debug_uuid} /* Debug */,')
    lines.append(f'\t\t\t\t{project_release_uuid} /* Release */,')
    lines.append('\t\t\t);')
    lines.append('\t\t\tdefaultConfigurationIsVisible = 0;')
    lines.append('\t\t\tdefaultConfigurationName = Release;')
    lines.append('\t\t};')
    lines.extend(config_list_lines)
    lines.append('/* End XCConfigurationList section */')
    lines.append('')

    lines.append('\t};')
    lines.append(f'\trootObject = {project_uuid} /* Project object */;')
    lines.append('}')

    return '\n'.join(lines)


def main():
    print("Collecting source files per target...")
    total = 0
    count = 0
    for name, src_dir, ptype, _ in TARGETS:
        _, files = collect_files_for_dir(src_dir)
        if files:
            count += 1
            total += len(files)
            icon = {'lib': 'L', 'exe': 'E', 'bundle': 'B', 'app': 'A'}[ptype]
            print(f"  [{icon}] {name:30s} {len(files):4d} files")

    print(f"\nTotal: {total} files across {count} targets")

    os.makedirs(XCODEPROJ_DIR, exist_ok=True)

    print("Generating project.pbxproj...")
    pbxproj = generate_pbxproj()
    with open(XCODEPROJ_DIR / "project.pbxproj", 'w') as f:
        f.write(pbxproj)

    # Workspace
    ws_dir = XCODEPROJ_DIR / "project.xcworkspace"
    os.makedirs(ws_dir, exist_ok=True)
    with open(ws_dir / "contents.xcworkspacedata", 'w') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version = "1.0">\n'
                '   <FileRef location = "self:Ardour.xcodeproj"/>\n</Workspace>\n')

    # Scheme for ardour-gui
    scheme_dir = XCODEPROJ_DIR / "xcshareddata" / "xcschemes"
    os.makedirs(scheme_dir, exist_ok=True)
    for scheme_target in ['ardour-gui', 'ardour-lua', 'hardour', 'libardour']:
        with open(scheme_dir / f"{scheme_target}.xcscheme", 'w') as f:
            f.write(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1500" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForRunning = "YES" buildForTesting = "YES"
            buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference BuildableIdentifier = "primary"
               BlueprintName = "{scheme_target}"
               ReferencedContainer = "container:Ardour.xcodeproj"/>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
</Scheme>
''')

    print(f"\nXcode project: {XCODEPROJ_DIR}")
    print(f"Targets: {count} native targets (libraries, tools, bundles)")
    print("Open with: open Ardour.xcodeproj")


if __name__ == '__main__':
    main()
