/*
 * Copyright (C) 2026 Robin Gareus <robin@gareus.org>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

#include "pbd/basename.h"
#include "pbd/compose.h"

#ifdef WAF_BUILD
#include "libardour-config.h"
#endif

#include <glibmm.h>

#include "pbd/convert.h"

#include "ardour/demo_sessions.h"
#include "ardour/filename_extensions.h"
#include "ardour/rc_configuration.h"
#include "ardour/session.h"

#include "pbd/i18n.h"

using namespace ARDOUR;
using namespace std;
using namespace PBD;

std::string
ARDOUR::demo_session_dir ()
{
	std::string p;
	const char* c = nullptr;

	if ((c = getenv ("XDG_DATA_HOME")) != 0) {
		/* default:  $HOME/.local/share */
		p = c;
		p = Glib::build_filename (p, PBD::downcase (PROGRAM_NAME), "demo_sessions");
	} else {
#ifdef __APPLE__
		p = Glib::build_filename (Glib::get_home_dir (), "Library", "/Application Support", PROGRAM_NAME, "Demo Sessions");
#elif defined PLATFORM_WINDOWS
		p = Glib::build_filename (Glib::get_user_data_dir (), PROGRAM_NAME, "Demo Sessions");
#else
		/* Linux, *BSD: use XDG_DATA_HOME prefix, version-independent app folder */
		p = Glib::build_filename (Glib::get_user_data_dir (), PBD::downcase (PROGRAM_NAME), "demo_sessions");
#endif
	}

	if (!Glib::file_test (p, Glib::FILE_TEST_EXISTS)) {
		if (g_mkdir_with_parents (p.c_str (), 0755)) {
      error << string_compose (_("Cannot create Demo Session directory '%1'"), p) << endmsg;
		}
	}

	return p;
}

int
ARDOUR::inflate_demo_session (std::string const& demo, std::string save_as)
{
	string src = Glib::build_filename (demo_session_dir(), string_compose ("%1%2", demo, ARDOUR::session_archive_suffix));

	//printf ("EXTRACT %s to %s\n", src.c_str(), save_as.c_str());

	if (!Glib::file_test (src, Glib::FILE_TEST_EXISTS | Glib::FILE_TEST_IS_REGULAR)) {
		error << string_compose (_("Cannot find Demo Session '%1'"), src) << endmsg;
		return -1;
	}

	string dst;
	if (save_as.find (G_DIR_SEPARATOR) == string::npos) {
		string dsd = Config->get_default_session_parent_dir();
		dst = Glib::build_filename (dsd, string_compose ("%1%2", save_as));
	} else {
		dst = save_as;
		save_as = PBD::basename_nosuffix (save_as);
	}

	if (Glib::file_test (dst, Glib::FILE_TEST_EXISTS)) {
		error << string_compose (_("Target folder for Demo Session exists '%1'"), dst) << endmsg;
		return -3;
		//PBD::remove_directory (dst);
	}

	try {
		PBD::FileArchive ar (src, NULL);
		std::string const prefix = demo + "/";
		std::string const interchange = "interchange/" + demo;

		for (std::string fn = ar.next_file_name(); !fn.empty(); fn = ar.next_file_name()) {
			size_t pos = fn.find (prefix);
			if (pos != 0) {
				continue;
			}

			std::string ofn (fn.substr (prefix.length ()));

			if (ofn == string_compose ("%1%2", demo, ARDOUR::statefile_suffix)) {
				ofn = string_compose ("%1%2", save_as, ARDOUR::statefile_suffix);
			} else if ((pos = ofn.find (interchange)) != string::npos) {
				ofn = "interchange/" + save_as + ofn.substr (pos + interchange.length ());
			}

			const std::string dest = Glib::build_filename (dst, ofn);
			//printf ("EXTRACT %s\n", dest.c_str());
			ar.extract_current_file (dest);
		}
		// store_recent_sessions (save_as, dsd);
	} catch (...) {
		return 1;
	}

	return 0;
}
