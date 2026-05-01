# Pinned Ardour build dependencies for the 4em fork.
# Matches build_ardour.sh::install_deps formula list exactly.
# Format: presence-only (no version pins). For SOVERSION drift detection
# see scripts/check_dylibs.sh + the future Brewfile.lock.json.

# Core build tools
brew "pkg-config"
brew "python@3"

# Required libraries (from wscript check_pkg calls)
brew "glib"
brew "glibmm"
brew "libsndfile"
brew "libarchive"
brew "liblo"
brew "taglib"
brew "vamp-plugin-sdk"
brew "rubberband"
brew "boost"
brew "libusb"
brew "aubio"

# LV2 plugin ecosystem
brew "lv2"
brew "serd"
brew "sord"
brew "sratom"
brew "lilv"
brew "suil"
brew "lrdf"

# GTK stack (needed for full build including GUI)
brew "gtk+"
brew "gtkmm"
brew "cairomm"
brew "pangomm"
brew "atkmm"

# Additional tools/libs
brew "fftw"
brew "libxml2"
brew "readline"
brew "gettext"
brew "libwebsockets"
brew "cppunit"
