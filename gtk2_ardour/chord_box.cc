/*
 * Copyright (C) 2026 Paul Davis <paul@linuxaudiosystems.com>
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

#include "gtkmm2ext/actions.h"

#include "chord_box.h"

#include "pbd/i18n.h"

using namespace ARDOUR;

struct DoubleButton : public Gtk::HBox
{
	DoubleButton (ArdourWidgets::ArdourButton & left, ArdourWidgets::ArdourButton & right);
};

DoubleButton::DoubleButton (ArdourWidgets::ArdourButton & left, ArdourWidgets::ArdourButton & right)
{
	using namespace ArdourWidgets;

	left.set_corner_mask (ArdourButton::LEFT);
	left.set_border_mask (ArdourButton::HIDE_RIGHT);

	right.set_corner_mask (ArdourButton::RIGHT);
	right.set_border_mask (ArdourButton::HIDE_LEFT);

	pack_start (left, true, true);
	pack_start (right, false, false);
	left.show ();
	right.show ();
}


ChordBox::ChordBox ()
	: triad_label (_("3-Note Chords (Triads)"))
	, tetrad_label (_("4-Note Chords (Tetrads)"))
	, inversion_label (_("Inversions"))
	, drop_label (_("Drop Notes"))
	, _root (0)
	, _culture (WesternEurope12TET)
	, _scale_provider (nullptr)
{
	using namespace Gtk;
	using namespace Menu_Helpers;
	using namespace ArdourWidgets;

	if (tet12_chords.empty()) {
		build_12tet_chords ();
		register_actions ();
	}

	/* these must match the enum decl order */
	culture_button.add_menu_elem (MenuElem (_("Western 12TET"), [this]() { set_culture (WesternEurope12TET); }));
	culture_button.add_menu_elem (MenuElem (_("Byzantine"), [this]() { set_culture (Byzantine); }));
	culture_button.add_menu_elem (MenuElem (_("Maqams"), [this]() { set_culture (Maqams); }));;
	culture_button.add_menu_elem (MenuElem (_("Hindustani"), [this]() { set_culture (Hindustani); }));;
	culture_button.add_menu_elem (MenuElem (_("Carnatic"), [this]() { set_culture (Carnatic); }));;
	culture_button.add_menu_elem (MenuElem (_("SEAsia"), [this]() { set_culture (SEAsia); }));;
	culture_button.add_menu_elem (MenuElem (_("China"), [this]() { set_culture (China); }));

	pack_start (culture_button, false, false);
	culture_button.show ();
	culture_button.set_active (0);

	set_border_width (12);
	set_spacing (6);
}

ChordBox::~ChordBox ()
{
}

void
ChordBox::set_culture (MusicalModeCulture culture)
{
	if (culture_button.get_active_row_number() != (int) culture) {
		culture_button.set_active ((int) culture);
	}

	_culture = culture;

	switch (_culture) {
	case WesternEurope12TET:
		if (western_vbox.children().empty()) {
			build_western ();
		}
		pack (western_vbox);
		break;
	case Byzantine:
		break;
	case Maqams:
		break;
	case Hindustani:
		break;
	case Carnatic:
		break;
	case SEAsia:
		break;
	case China:
		break;
	}
}


void
ChordBox::pack (Gtk::Widget& widget)
{
	if (western_vbox.get_parent()) {
		remove (western_vbox);
	}
	/* Other culture boxes go here */

	pack_start (widget, false, false);
}

void
ChordBox::build_western ()
{
	using namespace Gtk;
	using namespace Menu_Helpers;
	using namespace ArdourWidgets;

	root_dropdown.add_menu_elem (MenuElem (S_("Note|C"), [this]() { set_root (0); }));
	root_dropdown.set_active (0);

	triad_table.resize (3, 2);
	tetrad_table.resize (5, 2);
	inversion_table.resize (1, 2);
	drop_table.resize (2, 2);

	ArdourButton* butl;
	ArdourButton* butr;
	DoubleButton* dbut;
	int row = 0;
	int col = 0;

	butl = manage (new ArdourButton (_("maj")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("maj")); });
	butr = manage (new ArdourButton (ArdourButton::VectorIcon, true));
	butr->signal_clicked.connect ([this]() { tet12_chord_chosen (_("maj")); });
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	triad_table.attach (*dbut, col, col+1, row, row+1);
	col++;
	butl = manage (new ArdourButton (_("min")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("min")); });
	butr = manage (new ArdourButton (ArdourButton::VectorIcon, true));
	butr->signal_clicked.connect ([this]() { tet12_chord_chosen (_("min")); });
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	triad_table.attach (*dbut, col, col+1, row, row+1);
	col = 0;
	row++;

	butl = manage (new ArdourButton (_("sus4")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("sus4")); });
	butr = manage (new ArdourButton (ArdourButton::VectorIcon, true));
	butr->signal_clicked.connect ([this]() { tet12_chord_chosen (_("sus4")); });
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	triad_table.attach (*dbut, col, col+1, row, row+1);
	col++;
	butl = manage (new ArdourButton (_("sus2")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("sus2")); });
	butr = manage (new ArdourButton (ArdourButton::VectorIcon, true));
	butr->signal_clicked.connect ([this]() { tet12_chord_chosen (_("sus2")); });
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	triad_table.attach (*dbut, col, col+1, row, row+1);
	col = 0;
	row++;

	butl = manage (new ArdourButton (_("dim")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("dim")); });
	butr = manage (new ArdourButton (ArdourButton::VectorIcon, true));
	butr->signal_clicked.connect ([this]() { tet12_chord_chosen (_("dim")); });
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	triad_table.attach (*dbut, col, col+1, row, row+1);
	col++;
	butl = manage (new ArdourButton (_("aug")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("aug")); });
	butr = manage (new ArdourButton (ArdourButton::VectorIcon, true));
	butr->signal_clicked.connect ([this]() { tet12_chord_chosen (_("aug")); });
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	triad_table.attach (*dbut, col, col+1, row, row+1);
	col = 0;
	row++;

	triad_table.set_homogeneous (true);
	triad_table.set_col_spacings (6);

	/* Tetrads */

	row = 0;
	col = 0;

	butl = manage (new ArdourButton (_("maj7")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("maj7")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col++;
	butl = manage (new ArdourButton (_("7")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("7")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col = 0;
	row++;

	butl = manage (new ArdourButton (_("min7")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("min7")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col++;
	butl = manage (new ArdourButton (_("min6")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("min6")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col = 0;
	row++;

	butl = manage (new ArdourButton (_("min7/b5")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("min7/b5")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col++;
	butl = manage (new ArdourButton (_("minj7")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("minj7")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col = 0;
	row++;

	butl = manage (new ArdourButton (_("sus4/7")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("sus4/7")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col++;
	butl = manage (new ArdourButton (_("sus2/7")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("sus2/7")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col = 0;
	row++;

	butl = manage (new ArdourButton (_("full dim")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("full dim")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col++;
	butl = manage (new ArdourButton (_("maj7/#5")));
	butl->signal_clicked.connect ([this]() { tet12_replace_chord (_("maj7/#5")); });
	butr = manage (new ArdourButton);
	butr->set_icon (ArdourIcon::ToolDraw);
	dbut = new DoubleButton (*butl, *butr);
	tetrad_table.attach (*dbut, col, col+1, row, row+1);
	col = 0;
	row++;

	tetrad_table.set_homogeneous (true);
	tetrad_table.set_col_spacings (6);

	/* Inversions */

	row = 0;
	col = 0;

	ArdourButton* but;

	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Move Up"));
	inversion_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Move Down"));
	inversion_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;

	inversion_table.set_homogeneous (true);
	inversion_table.set_col_spacings (6);

	/* Drops */

	row = 0;
	col = 0;

	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Drop 2"));
	drop_table.attach (*but, col, col+1, row, row+1);
	col++;
	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Drop 3"));
	drop_table.attach (*but, col, col+1, row, row+1);
	col = 0;
	row++;
	but = manage (new ArdourButton);
	but->set_elements (ArdourButton::Element (ArdourButton::Edge|ArdourButton::Body|ArdourButton::Text));
	but->set_text (_("Drop 2 + 4"));
	drop_table.attach (*but, col, col+2, row, row+1);
	col = 0;
	row++;

	drop_table.set_homogeneous (true);
	drop_table.set_col_spacings (6);


	triad_label.set_alignment (0.0, 0.5);
	tetrad_label.set_alignment (0.0, 0.5);
	inversion_label.set_alignment (0.0, 0.5);
	drop_label.set_alignment (0.0, 0.5);

	western_vbox.pack_start (root_dropdown, false, false);
	western_vbox.pack_start (triad_label, false, false);
	western_vbox.pack_start (triad_table, false, false);
	western_vbox.pack_start (tetrad_label, false, false);
	western_vbox.pack_start (tetrad_table, false, false);
	western_vbox.pack_start (inversion_label, false, false);
	western_vbox.pack_start (inversion_table, false, false);
	western_vbox.pack_start (drop_label, false, false);
	western_vbox.pack_start (drop_table, false, false);

	western_vbox.show_all ();
	western_vbox.set_spacing (6);

	pack_start (western_vbox);
}

void
ChordBox::set_root (int num)
{
	if (root_dropdown.get_active_row_number() != num) {
		root_dropdown.set_active (num);
	}
}

int
ChordBox::get_root () const
{
	return 0;
}

void
ChordBox::set_scale_provider (ScaleProvider const * sp)
{
	_scale_provider = sp;
}

bool
ChordBox::get_midi_chord (int root_pitch, std::vector<int>& pitches) const
{
	if (target_chord.empty()) {
		return false;
	}

	auto res = tet12_chords.find (target_chord);

	if (res != tet12_chords.end()) {
		for (auto & interval : res->second) {
			pitches.push_back (root_pitch + interval);
		}
		return true;
	}

	return false;
}

void
ChordBox::tet12_chord_chosen (std::string const & name)
{
	if (tet12_chords.find (name) != tet12_chords.end()) {
		target_chord = name;
	} else {
		target_chord = std::string();
	}
}

void
ChordBox::tet12_replace_chord (std::string const & name)
{
	auto res = tet12_chords.find (name);

	if (res != tet12_chords.end()) {
		ReplaceChord (res->second); /* EMIT SIGNAL */
	}
}

void
ChordBox::register_actions ()
{
#if 0
	using namespace Gtk;

	Glib::RefPtr<ActionGroup> chord_actions = ActionManager::create_action_group (bindings, X_("Chords"));

	RadioAction::Group triad_group;
	Glib::RefPtr<RadioAction> ract;

	ActionManager::register_radio_action (chord_actions, triad_group, X_("use-chord-major"), _("Chord|maj"), []() { te12_chord_chosen (_("maj")); });
	ActionManager::register_radio_action (chord_actions, triad_group, X_("use-chord-minor"), _("Chord|min"), []() { te12_chord_chosen (_("min")); });
	ActionManager::register_radio_action (chord_actions, triad_group, X_("use-chord-sus4"), _("Chord|sus4"), []() { te12_chord_chosen (_("sus4")); });
	ActionManager::register_radio_action (chord_actions, triad_group, X_("use-chord-sus2"), _("Chord|sus2"), []() { te12_chord_chosen (_("sus2")); });
	ActionManager::register_radio_action (chord_actions, triad_group, X_("use-chord-dom"), _("Chord|dom"), []() { te12_chord_chosen (_("dom")); });
	ActionManager::register_radio_action (chord_actions, triad_group, X_("use-chord-aug"), _("Chord|aug"), []() { te12_chord_chosen (_("aug")); });
#endif
}
